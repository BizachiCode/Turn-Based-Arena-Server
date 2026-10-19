import type { Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";
import { AppCloseCode } from "../../shared/protocol/close-codes.js";
import type { ActiveBattleRegistry } from "../../shared/rooms/active-battles.js";
import { AuthenticatedRoom, type RoomIdentity } from "../../shared/rooms/authenticated-room.js";
import { clientAddress } from "../../shared/rooms/client-address.js";
import { notifyUserRevoked } from "../../shared/rooms/user-revocation.js";
import type {
  RuntimeDisconnectNotice,
  RuntimeMaintenanceBroadcast,
  RuntimePlayerGrantPayload,
  RuntimeServerNotice,
} from "../../infrastructure/runtime/server-runtime-state.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { activeBattleDto } from "../battle-pve/battle-pve.room.js";
import type { ReportService } from "../report/report.service.js";
import { ReportPlayerSchema } from "../report/report.validation.js";
import { HeartbeatGate } from "./presence.heartbeat.js";
import type { PresenceService } from "./presence.service.js";

export class PresenceState extends Schema {}

export type PresenceRoomDeps = {
  presence: PresenceService;
  maintenanceState: () => RuntimeMaintenanceBroadcast;
  /** Player reports (`report_player`); the room every logged-in client keeps open. */
  reports: ReportService;
  /** Expensive-action bucket (per user). */
  reportLimiter: RateLimiter;
  /** The player's live battle (`battle_active`). */
  activeBattles: ActiveBattleRegistry;
  /** Shared per-user `query` bucket. */
  queryLimiter: RateLimiter;
};

type JoinOptions = { accessToken?: string; deviceId?: string; userAgent?: string };

const ONLINE_COUNT_INTERVAL_MS = 15_000;
/** Old `user_sessions` rows are pruned this often (first run shortly after the room opens). */
const SESSION_PRUNE_INTERVAL_MS = 6 * 3_600_000;
const SESSION_PRUNE_FIRST_DELAY_MS = 60_000;
/** Presence rooms of one process all receive the same GM kick; the revocation event is published once per window. */
const KICK_EVENT_WINDOW_MS = 1_000;
const recentKickEvents = new Map<string, number>();

/**
 * Presence room: tracks connections, answers heartbeats and receives server pushes
 * (maintenance, notices, forced disconnects, GM grants, new mail) through `remoteRoomCall`.
 */
export class PresenceRoom extends AuthenticatedRoom<PresenceState, PresenceRoomDeps> {
  state = new PresenceState();
  private readonly heartbeatGates = new WeakMap<Client, HeartbeatGate>();

  onCreate(): void {
    // Heartbeat: fire-and-forget, no reply. A revoked session is kicked with SESSION_REVOKED. Heartbeats closer
    // together than HEARTBEAT_MIN_INTERVAL_MS are ignored (no session lookup, no database write).
    this.onMessage("hb", (client: Client) => {
      if (!this.acceptHeartbeat(client)) return;
      this.heartbeat(client).catch((error) => this.logger.error("heartbeat failed:", error));
    });

    // Request: the reporter is always the session user; evidence is copied from the stored chat history.
    this.handleAuthenticatedRequest("report_player", {
      schema: ReportPlayerSchema,
      rateLimit: this.deps.reportLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await this.deps.reports.report(userId, dto)) }),
    });

    // The battle the player may resume (after a crash or an app restart): its room id and battle id, or null.
    this.handleAuthenticatedRequest("battle_active", {
      rateLimit: this.deps.queryLimiter,
      handle: async ({ userId }) => {
        const active = await this.deps.activeBattles.find(userId);
        return { ok: true, active: active ? activeBattleDto(active) : null };
      },
    });

    this.clock.setInterval(async () => {
      try {
        this.broadcast("online_count", await this.deps.presence.getOnlineCount());
      } catch {
        // keep presence resilient if the counter query fails
      }
    }, ONLINE_COUNT_INTERVAL_MS);

    // Every connection inserts a `user_sessions` row: drop the ones past the retention window.
    const prune = async () => {
      try {
        const removed = await this.deps.presence.pruneSessions();
        if (removed > 0) this.logger.info(`pruned ${removed} old connection row(s)`);
      } catch (error) {
        this.logger.warn("session prune failed:", error);
      }
    };
    this.clock.setTimeout(prune, SESSION_PRUNE_FIRST_DELAY_MS);
    this.clock.setInterval(prune, SESSION_PRUNE_INTERVAL_MS);
  }

  async onJoin(client: Client, options: JoinOptions): Promise<void> {
    const identity = client.auth as RoomIdentity;
    try {
      await this.deps.presence.registerConnection({
        sessionId: client.sessionId,
        userId: identity.userId,
        deviceId: identity.deviceId,
        address: clientAddress(client),
        userAgent: typeof options?.userAgent === "string" ? options.userAgent.slice(0, 255) : null,
      });
    } catch (error) {
      this.logger.error("join db error:", error);
      client.leave(AppCloseCode.INTERNAL_ERROR, "db error");
      return;
    }

    client.send("maintenance_changed", this.deps.maintenanceState());
  }

  async onLeave(client: Client, _code?: number): Promise<void> {
    try {
      await this.deps.presence.unregisterConnection(client.sessionId);
    } catch (error) {
      this.logger.error("leave db error:", error);
    }
  }

  private acceptHeartbeat(client: Client): boolean {
    let gate = this.heartbeatGates.get(client);
    if (!gate) {
      gate = new HeartbeatGate();
      this.heartbeatGates.set(client, gate);
    }
    return gate.accept(Date.now());
  }

  private async heartbeat(client: Client): Promise<void> {
    if (!(await this.isSessionActive(client))) {
      client.leave(AppCloseCode.SESSION_REVOKED, "session revoked");
      return;
    }
    await this.deps.presence.touch(client.sessionId);
  }

  public pushMaintenanceState(payload: RuntimeMaintenanceBroadcast): void {
    this.broadcast("maintenance_changed", payload);
  }

  public pushServerNotice(payload: RuntimeServerNotice): void {
    this.broadcast("server_notice", payload);
  }

  public pushDisconnectNotice(payload: RuntimeDisconnectNotice): void {
    this.broadcast("disconnect_notice", payload);
  }

  /** `mail_new` to the player's connections (the client then asks `mail/summary`). */
  public pushMailNotice(userId: string, payload: object): number {
    let delivered = 0;
    for (const client of this.clients) {
      if ((client.auth as RoomIdentity | undefined)?.userId !== userId) continue;
      client.send("mail_new", payload);
      delivered++;
    }
    return delivered;
  }

  /** `social_event` to the player's connections (friends, private messages, friendly battles). */
  public pushSocialEvent(userId: string, payload: object): number {
    let delivered = 0;
    for (const client of this.clients) {
      if ((client.auth as RoomIdentity | undefined)?.userId !== userId) continue;
      client.send("social_event", payload);
      delivered++;
    }
    return delivered;
  }

  /** `mail_new` to every connection (broadcast mail). */
  public pushMailBroadcast(payload: object): void {
    this.broadcast("mail_new", payload);
  }

  /** GM kick/ban: tells the player's connections why (`disconnect_notice`) and closes them with `payload.closeCode`. */
  public kickUser(userId: string, payload: RuntimeDisconnectNotice): number {
    let kicked = 0;
    for (const client of [...this.clients]) {
      if ((client.auth as RoomIdentity | undefined)?.userId !== userId) continue;
      client.send("disconnect_notice", payload);
      client.leave(payload.closeCode, payload.reason);
      kicked++;
    }
    this.publishRevocation(userId);
    return kicked;
  }

  /**
   * The GM revoked this player's sessions first: tell every room (not only the presence ones) to drop the connections
   * whose session is gone, so a banned player can't keep a chat socket open. Sent after the notices above.
   */
  private publishRevocation(userId: string): void {
    const nowMs = Date.now();
    if (nowMs - (recentKickEvents.get(userId) ?? 0) < KICK_EVENT_WINDOW_MS) return;
    recentKickEvents.set(userId, nowMs);
    for (const [id, at] of recentKickEvents) if (nowMs - at >= KICK_EVENT_WINDOW_MS) recentKickEvents.delete(id);
    notifyUserRevoked(userId);
  }

  public pushPlayerGrant(userId: string, payload: RuntimePlayerGrantPayload): number {
    let delivered = 0;
    for (const client of this.clients) {
      if ((client.auth as RoomIdentity | undefined)?.userId !== userId) continue;
      client.send("player_grant", payload);
      delivered++;
    }
    return delivered;
  }
}
