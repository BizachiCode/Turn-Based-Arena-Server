import os from "node:os";
import { matchMaker } from "@colyseus/core";
import { env } from "../../config/env.js";
import { AppCloseCode } from "../../shared/protocol/close-codes.js";

const DEFAULT_MAINTENANCE_MESSAGE = "Server under maintenance.";
const DEFAULT_DISCONNECT_CODE: number = AppCloseCode.MAINTENANCE_DISCONNECT;
const MAX_ACTIVITY_ENTRIES = 20;
const DEFAULT_NOTICE_DISMISS_SECONDS = 8;
const MAX_TELEMETRY_ENTRIES = 72;
const TELEMETRY_SAMPLE_INTERVAL_MS = 10_000;

export type RuntimeMaintenanceBroadcast = {
  enabled: boolean;
  message: string | null;
  startedAt: string | null;
  updatedAt: string;
};

export type RuntimeServerNotice = {
  kind: string;
  title: string | null;
  message: string;
  dismissSeconds: number;
  createdAt: string;
};

export type RuntimeDisconnectNotice = {
  closeCode: number;
  reason: string;
  createdAt: string;
};

export type RuntimeGrantedCharacter = {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  currentExp: number;
  awakened: boolean;
  skillLevels: number[];
  awakeningIndex: number;
  location: "BAG" | "STORAGE";
};

export type RuntimeGrantedRune = {
  uid: string;
  setId: string;
  slot: number;
  tier: number;
  variant: string;
  quality: number;
  level: number;
  mainStatType: string;
  mainStatValue: number;
  substats: Array<{
    stat: string;
    value: number;
    grind?: number;
    gem?: boolean;
  }>;
  origin: string | null;
  locked: number;
  favorite: number;
  equippedToUid: string | null;
};

export type RuntimePlayerGrantPayload = {
  grantedAt: string;
  reason: string | null;
  wallet?: Record<string, number>;
  characters?: RuntimeGrantedCharacter[];
  runes?: RuntimeGrantedRune[];
};

export type RuntimeRoomSummary = {
  roomId: string;
  name: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  private: boolean;
  processId: string | null;
  createdAt: string | null;
};

export type RuntimeActivityEntry = {
  at: string;
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
};

export type RuntimeHostSnapshot = {
  hostname: string;
  platform: string;
  processId: number;
  nodeVersion: string;
  cpuCount: number;
  totalMemMb: number;
  freeMemMb: number;
  usedMemPercent: number;
  rssMb: number;
  heapUsedMb: number;
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
};

export type RuntimeTelemetryPoint = {
  at: string;
  rooms: number;
  clients: number;
  rssMb: number;
  heapUsedMb: number;
  systemMemUsedPercent: number;
  freeMemMb: number;
  totalMemMb: number;
};

export type DisconnectSummary = {
  at: string;
  closeCode: number;
  reason: string;
  targetedRooms: number;
  targetedClients: number;
  failedRooms: Array<{
    roomId: string;
    roomName: string;
    error: string;
  }>;
};

export type RuntimeDashboardSnapshot = {
  serverTime: string;
  uptimeSec: number;
  maintenance: {
    enabled: boolean;
    bootDefaultEnabled: boolean;
    message: string | null;
    startedAt: string | null;
    updatedAt: string;
  };
  totals: {
    rooms: number;
    clients: number;
  };
  host: RuntimeHostSnapshot;
  telemetry: {
    current: RuntimeTelemetryPoint;
    history: RuntimeTelemetryPoint[];
  };
  rooms: RuntimeRoomSummary[];
  lastDisconnect: DisconnectSummary | null;
  recentActivity: RuntimeActivityEntry[];
};

export type SetMaintenanceInput = {
  enabled: boolean;
  message?: string;
  disconnectPlayers?: boolean;
  closeCode?: number;
  reason?: string;
};

export type BroadcastNoticeInput = {
  kind?: string;
  title?: string;
  message: string;
  dismissSeconds?: number;
};

export class ServerRuntimeState {
  private maintenanceEnabled = env.maintenanceMode;
  private maintenanceMessage = env.maintenanceMode ? DEFAULT_MAINTENANCE_MESSAGE : "";
  private maintenanceUpdatedAt = new Date().toISOString();
  private maintenanceStartedAt = env.maintenanceMode ? this.maintenanceUpdatedAt : null;
  private lastDisconnect: DisconnectSummary | null = null;
  private readonly recentActivity: RuntimeActivityEntry[] = [];
  private readonly telemetryHistory: RuntimeTelemetryPoint[] = [];
  private lastTelemetrySampleAt = 0;

  constructor() {
    this.recordActivity(
      "boot",
      env.maintenanceMode
        ? "Server booted with maintenance mode enabled."
        : "Server runtime controls initialized."
    );
  }

  public isMaintenanceEnabled(): boolean {
    return this.maintenanceEnabled;
  }

  public getMaintenanceMessage(): string {
    const message = this.maintenanceMessage.trim();
    return message.length > 0 ? message : DEFAULT_MAINTENANCE_MESSAGE;
  }

  public getHealthPayload() {
    const serverTime = new Date().toISOString();

    if (this.maintenanceEnabled) {
      return {
        ok: false,
        code: "MAINTENANCE",
        message: this.getMaintenanceMessage(),
        maintenance: true,
        uptime: process.uptime(),
        serverTime,
      };
    }

    return {
      ok: true,
      maintenance: false,
      uptime: process.uptime(),
      serverTime,
    };
  }

  public async getDashboardSnapshot(): Promise<RuntimeDashboardSnapshot> {
    const rooms = await this.listRooms();
    const clients = rooms.reduce((sum, room) => sum + room.clients, 0);
    const telemetry = this.captureTelemetry(rooms.length, clients);

    return {
      serverTime: new Date().toISOString(),
      uptimeSec: process.uptime(),
      maintenance: {
        enabled: this.maintenanceEnabled,
        bootDefaultEnabled: env.maintenanceMode,
        message: this.maintenanceMessage.trim() || null,
        startedAt: this.maintenanceStartedAt,
        updatedAt: this.maintenanceUpdatedAt,
      },
      totals: {
        rooms: rooms.length,
        clients,
      },
      host: telemetry.host,
      telemetry: {
        current: telemetry.current,
        history: telemetry.history,
      },
      rooms,
      lastDisconnect: this.lastDisconnect,
      recentActivity: [...this.recentActivity],
    };
  }

  public async setMaintenance(input: SetMaintenanceInput) {
    const now = new Date().toISOString();
    const normalizedMessage = typeof input.message === "string" ? input.message.trim() : undefined;

    this.maintenanceEnabled = input.enabled;
    if (normalizedMessage !== undefined) {
      this.maintenanceMessage = normalizedMessage;
    }

    if (input.enabled) {
      this.maintenanceStartedAt = this.maintenanceStartedAt ?? now;
    } else {
      this.maintenanceStartedAt = null;
    }

    this.maintenanceUpdatedAt = now;
    this.recordActivity(
      "maintenance",
      input.enabled ? "Maintenance enabled." : "Maintenance disabled.",
      {
        message: this.maintenanceMessage.trim() || null,
      }
    );

    await this.broadcastMaintenanceState();

    let disconnect: DisconnectSummary | null = null;
    if (input.disconnectPlayers) {
      disconnect = await this.disconnectAllPlayers(
        input.closeCode,
        input.reason || this.getMaintenanceMessage()
      );
    }

    return {
      snapshot: await this.getDashboardSnapshot(),
      disconnect,
    };
  }

  public async disconnectAllPlayers(
    closeCode = DEFAULT_DISCONNECT_CODE,
    reason = "Disconnected by GM panel."
  ): Promise<DisconnectSummary> {
    const normalizedReason = String(reason || "Disconnected by GM panel.").trim() || "Disconnected by GM panel.";
    await this.broadcastDisconnectNotice({
      closeCode,
      reason: normalizedReason,
      createdAt: new Date().toISOString(),
    });
    await this.delay(450);

    const rooms = await matchMaker.query({});
    const activeRooms = rooms.filter((room) => this.toNumber(room.clients) > 0);

    const failedRooms: DisconnectSummary["failedRooms"] = [];
    const targetedClients = activeRooms.reduce((sum, room) => sum + this.toNumber(room.clients), 0);

    const results = await Promise.allSettled(
      activeRooms.map((room) => matchMaker.remoteRoomCall(room.roomId, "disconnect", [closeCode]))
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }

      const room = activeRooms[index];
      failedRooms.push({
        roomId: String(room.roomId ?? ""),
        roomName: String(room.name ?? ""),
        error: this.readError(result.reason),
      });
    });

    const summary: DisconnectSummary = {
      at: new Date().toISOString(),
      closeCode,
      reason: normalizedReason,
      targetedRooms: activeRooms.length,
      targetedClients,
      failedRooms,
    };

    this.lastDisconnect = summary;
    this.recordActivity(
      "disconnect",
      `Disconnect request sent to ${targetedClients} player connection(s).`,
      {
        closeCode,
        reason: normalizedReason,
        targetedRooms: activeRooms.length,
        failedRooms: failedRooms.length,
      }
    );

    return summary;
  }

  public async broadcastNotice(input: BroadcastNoticeInput) {
    const message = String(input.message || "").trim();
    if (!message) {
      throw new Error("Notice message is required.");
    }

    const payload: RuntimeServerNotice = {
      kind: String(input.kind || "info").trim() || "info",
      title: typeof input.title === "string" && input.title.trim().length > 0
        ? input.title.trim()
        : null,
      message,
      dismissSeconds: this.normalizeDismissSeconds(input.dismissSeconds),
      createdAt: new Date().toISOString(),
    };

    await this.broadcastToPresenceRooms("pushServerNotice", payload);
    this.recordActivity("notice", `Runtime notice broadcast: ${message}`, {
      kind: payload.kind,
      dismissSeconds: payload.dismissSeconds,
      hasTitle: !!payload.title,
    });

    return {
      notice: payload,
      snapshot: await this.getDashboardSnapshot(),
    };
  }

  public async pushPlayerGrant(
    userId: string,
    payload: RuntimePlayerGrantPayload,
    detail?: {
      targetLabel?: string | null;
      currencyId?: string | null;
      currencyAmount?: number | null;
    },
  ) {
    const deliveryCount = await this.sendToUserOnPresenceRooms("pushPlayerGrant", userId, payload);

    this.recordActivity(
      "grant",
      `GM grant sent to ${detail?.targetLabel || userId}.`,
      {
        deliveryCount,
        currencyId: detail?.currencyId ?? null,
        currencyAmount: detail?.currencyAmount ?? null,
        characters: payload.characters?.length ?? 0,
        runes: payload.runes?.length ?? 0,
        walletIncluded: !!payload.wallet,
      },
    );

    return {
      deliveryCount,
      snapshot: await this.getDashboardSnapshot(),
      grant: payload,
    };
  }

  /**
   * Closes one player's live connections with a notice (GM kick / ban). The caller revokes the sessions first, so the
   * other rooms drop the player on their next request and the client returns to the login screen.
   */
  public async disconnectPlayer(userId: string, reason: string, closeCode: number = AppCloseCode.SESSION_REVOKED, targetLabel?: string): Promise<number> {
    const normalizedReason = String(reason || "Disconnected by a GM.").trim() || "Disconnected by a GM.";
    const kicked = await this.sendToUserOnPresenceRooms("kickUser", userId, { closeCode, reason: normalizedReason, createdAt: new Date().toISOString() });
    this.recordActivity("disconnect", `GM disconnected ${targetLabel || userId} (${kicked} connection(s)).`, { closeCode, reason: normalizedReason });
    return kicked;
  }

  /** Tells the player's connected clients that their mailbox changed (`mail_new`); returns the deliveries. */
  public async pushMailNotice(userId: string): Promise<number> {
    return this.sendToUserOnPresenceRooms("pushMailNotice", userId, {});
  }

  /** `social_event` to the player's connected clients (friends, private messages, challenges); returns the deliveries. */
  public async pushSocialEvent(userId: string, payload: object): Promise<number> {
    return this.sendToUserOnPresenceRooms("pushSocialEvent", userId, payload);
  }

  /** Tells every connected client to refresh its mailbox badge (a broadcast mail was sent). */
  public async broadcastMailNotice(): Promise<void> {
    await this.broadcastToPresenceRooms("pushMailBroadcast", {});
  }

  public getMaintenanceBroadcast(): RuntimeMaintenanceBroadcast {
    return {
      enabled: this.maintenanceEnabled,
      message: this.maintenanceMessage.trim() || null,
      startedAt: this.maintenanceStartedAt,
      updatedAt: this.maintenanceUpdatedAt,
    };
  }

  private async listRooms(): Promise<RuntimeRoomSummary[]> {
    const rooms = await matchMaker.query({});
    return rooms
      .map((room) => ({
        roomId: String(room.roomId ?? ""),
        name: String(room.name ?? ""),
        clients: this.toNumber(room.clients),
        maxClients: this.toNumber(room.maxClients),
        locked: Boolean(room.locked),
        private: Boolean(room.private),
        processId: room.processId ? String(room.processId) : null,
        createdAt: this.toIsoString(room.createdAt),
      }))
      .sort((left, right) => {
        if (right.clients !== left.clients) {
          return right.clients - left.clients;
        }
        return left.name.localeCompare(right.name);
      });
  }

  private recordActivity(kind: string, message: string, detail?: Record<string, unknown>) {
    this.recentActivity.unshift({
      at: new Date().toISOString(),
      kind,
      message,
      detail,
    });

    if (this.recentActivity.length > MAX_ACTIVITY_ENTRIES) {
      this.recentActivity.length = MAX_ACTIVITY_ENTRIES;
    }
  }

  private captureTelemetry(roomCount: number, clientCount: number) {
    const now = Date.now();
    const memoryUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemPercent = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;

    const host: RuntimeHostSnapshot = {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      processId: process.pid,
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      totalMemMb: this.toMegabytes(totalMem),
      freeMemMb: this.toMegabytes(freeMem),
      usedMemPercent: this.roundNumber(usedMemPercent),
      rssMb: this.toMegabytes(memoryUsage.rss),
      heapUsedMb: this.toMegabytes(memoryUsage.heapUsed),
      loadAvg1m: this.roundNumber(os.loadavg()[0] ?? 0),
      loadAvg5m: this.roundNumber(os.loadavg()[1] ?? 0),
      loadAvg15m: this.roundNumber(os.loadavg()[2] ?? 0),
    };

    const current: RuntimeTelemetryPoint = {
      at: new Date(now).toISOString(),
      rooms: roomCount,
      clients: clientCount,
      rssMb: host.rssMb,
      heapUsedMb: host.heapUsedMb,
      systemMemUsedPercent: host.usedMemPercent,
      freeMemMb: host.freeMemMb,
      totalMemMb: host.totalMemMb,
    };

    const shouldStore =
      this.telemetryHistory.length === 0 ||
      now - this.lastTelemetrySampleAt >= TELEMETRY_SAMPLE_INTERVAL_MS;

    if (shouldStore) {
      this.telemetryHistory.push(current);
      this.lastTelemetrySampleAt = now;

      if (this.telemetryHistory.length > MAX_TELEMETRY_ENTRIES) {
        this.telemetryHistory.splice(0, this.telemetryHistory.length - MAX_TELEMETRY_ENTRIES);
      }
    }

    return {
      host,
      current,
      history: [...this.telemetryHistory],
    };
  }

  private toNumber(value: unknown): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  private toMegabytes(value: number): number {
    return this.roundNumber(value / (1024 * 1024));
  }

  private roundNumber(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private toIsoString(value: unknown): string | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }

  private readError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error ?? "UNKNOWN_ERROR");
  }

  private normalizeDismissSeconds(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return DEFAULT_NOTICE_DISMISS_SECONDS;
    }

    return Math.max(0, Math.min(120, Math.floor(num)));
  }

  private async broadcastMaintenanceState() {
    await this.broadcastToPresenceRooms("pushMaintenanceState", this.getMaintenanceBroadcast());
  }

  private async broadcastDisconnectNotice(payload: RuntimeDisconnectNotice) {
    await this.broadcastToPresenceRooms("pushDisconnectNotice", payload);
  }

  private async broadcastToPresenceRooms(methodName: string, payload: object) {
    const rooms = await matchMaker.query({ name: "presence" });
    const presenceRooms = rooms.filter((room) => String(room.name ?? "") === "presence");

    if (presenceRooms.length === 0) {
      return;
    }

    await Promise.allSettled(
      presenceRooms.map((room) => matchMaker.remoteRoomCall(String(room.roomId), methodName, [payload]))
    );
  }

  private async sendToUserOnPresenceRooms(methodName: string, userId: string, payload: object): Promise<number> {
    const rooms = await matchMaker.query({ name: "presence" });
    const presenceRooms = rooms.filter((room) => String(room.name ?? "") === "presence");

    if (presenceRooms.length === 0) {
      return 0;
    }

    const results = await Promise.allSettled(
      presenceRooms.map((room) => matchMaker.remoteRoomCall(String(room.roomId), methodName, [userId, payload]))
    );

    return results.reduce((sum, result) => {
      if (result.status !== "fulfilled") {
        return sum;
      }

      const delivered = Number(result.value ?? 0);
      return sum + (Number.isFinite(delivered) ? delivered : 0);
    }, 0);
  }

  private async delay(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const serverRuntimeState = new ServerRuntimeState();
