import type { Client } from "@colyseus/core";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { ActiveBattle, ActiveBattleMode, ActiveBattleRegistry } from "../../shared/rooms/active-battles.js";
import { AuthenticatedRoom, type RoomIdentity } from "../../shared/rooms/authenticated-room.js";
import type { RequestFailure } from "../../shared/rooms/request-handler.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { BattlePveSessionStepResult } from "./BattlePveSession.js";
import type { BattlePveService } from "./battle-pve.service.js";
import type { BattleSessionAdapter } from "./battle-session.adapter.js";
import { BattleStartGuard } from "./battle-start-guard.js";
import { BattleRoomPVEState } from "./battle-pve.state.js";
import type { ArenaBattleService } from "../arena/arena-battle.service.js";
import { ArenaBattleStartSchema } from "../arena/arena.validation.js";
import { BattleCommandSchema, BattleRefSchema, BattleStartSchema } from "./battle-pve.validation.js";

export type BattlePveRoomDeps = {
  battles: BattlePveService;
  /** Arena attacks (`battle_start_arena`) and their settlement. */
  arena: ArenaBattleService;
  limiter: RateLimiter;
  /** One live battle per player across rooms, devices and processes. */
  activeBattles: ActiveBattleRegistry;
  /** Seconds a dropped player may reconnect into a running battle (`social.json` > battleRooms; 0 = none). */
  reconnectSeconds: () => number;
};

function requestIdOf(raw: unknown): string {
  const value = (raw as { requestId?: unknown } | null)?.requestId;
  return typeof value === "string" ? value : "";
}

function frameError(failure: RequestFailure, raw: unknown) {
  return {
    ok: false,
    requestId: requestIdOf(raw),
    error: failure.error,
    ...(failure.message ? { message: failure.message } : {}),
    ...(failure.fields ?? {}),
  };
}

/** What the client learns about the battle that blocks a new start (`BATTLE_IN_PROGRESS`) or waits for it (`battle_active`). */
export function activeBattleDto(active: ActiveBattle) {
  return { roomId: active.roomId, battleId: active.battleId, mode: active.mode, sinceUnix: active.sinceUnix };
}

/** Battle frame sent after every step: state snapshot, the step's events and the player's action options. */
export function buildBattleFrame(battleId: string, result: BattlePveSessionStepResult) {
  return {
    battleId,
    phase: result.phase,
    turn: result.turn,
    round: result.round,
    finished: result.finished,
    victory: result.victory,
    winnerSideId: result.winnerSideId ?? null,
    finishedReason: result.finishedReason ?? null,
    awaitingPlayerInput: result.awaitingPlayerInput,
    activeUnitId: result.activeUnitId ?? null,
    activeSideId: result.activeSideId ?? null,
    currentWaveIndex: result.currentWaveIndex,
    totalWaves: result.totalWaves,
    actionOptions: result.actionOptions ?? null,
    actorOptions: result.actorOptions ?? null,
    turnOrder: result.turnOrder ?? null,
    state: result.state,
    events: result.events,
  };
}

/**
 * PvE battle room (`battle_pve`): one player, one authoritative battle session at a time (the client opens a room per
 * battle and leaves it at the end). The client only sends intents (skill + target, auto, surrender; skill levels come
 * from the roster); the final frame carries the rewards granted by the server (`result`).
 * A player holds one live battle across rooms and devices (`ActiveBattleRegistry`). A dropped connection may come back
 * with its reconnection token within `reconnectSeconds` and asks `battle_state` for the current frame.
 */
export class BattlePveRoom extends AuthenticatedRoom<BattleRoomPVEState, BattlePveRoomDeps> {
  state = new BattleRoomPVEState();
  private session: BattleSessionAdapter | null = null;
  private sessionOwnerId: string | null = null;
  private readonly startGuard = new BattleStartGuard();

  onCreate(): void {
    this.maxClients = 1;
    const { limiter, battles } = this.deps;

    this.handleAuthenticatedRequest("battle_start", {
      schema: BattleStartSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: async ({ userId }, req) => {
        const step = await this.beginSession(userId, "pve", () => battles.startBattle(userId, req));
        return this.frameResponse(userId, req.requestId, step);
      },
    });

    this.handleAuthenticatedRequest("battle_start_arena", {
      schema: ArenaBattleStartSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: async ({ userId }, req) => {
        const step = await this.beginSession(userId, "arena", () => this.deps.arena.startBattle(userId, req));
        return this.frameResponse(userId, req.requestId, step);
      },
    });

    this.handleAuthenticatedRequest("battle_command", {
      schema: BattleCommandSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => {
        const session = this.requireRunningSession(userId, req.battleId);
        return this.frameResponse(userId, req.requestId, session.usePlayerSkill({
          actorId: req.actorId,
          skillId: req.skillId,
          targetId: req.targetId,
        }));
      },
    });

    this.handleAuthenticatedRequest("battle_auto", {
      schema: BattleRefSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => this.frameResponse(userId, req.requestId, this.requireRunningSession(userId, req.battleId).usePlayerAuto()),
    });

    this.handleAuthenticatedRequest("battle_surrender", {
      schema: BattleRefSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => this.frameResponse(userId, req.requestId, this.requireRunningSession(userId, req.battleId).surrender()),
    });

    this.handleAuthenticatedRequest("battle_result", {
      schema: BattleRefSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: async ({ userId }, req) => {
        const session = this.requireSession(userId, req.battleId);
        const last = session.lastResult;
        if (!last || !last.finished) throw new AppError(ErrorCode.BATTLE_NOT_FINISHED);
        return {
          ok: true,
          requestId: req.requestId,
          battleId: session.battleId,
          result: await this.settle(userId, session, last),
        };
      },
    });

    // Current frame (after a reconnection): the last step with its action options. Its events were already played or
    // lost with the old connection, so the client rebuilds the scene from `state` instead of replaying them.
    this.handleAuthenticatedRequest("battle_state", {
      schema: BattleRefSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => {
        const session = this.requireSession(userId, req.battleId);
        const last = session.lastResult;
        if (!last) throw new AppError(ErrorCode.BATTLE_NOT_STARTED);
        return { ok: true, requestId: req.requestId, error: null, snapshot: true, ...buildBattleFrame(session.battleId, last) };
      },
    });
  }

  /**
   * Claims the player's battle slot for this room, builds the session and plays it up to the first player input. A
   * live battle in another room refuses the start with `BATTLE_IN_PROGRESS` + `activeBattle` (the client can resume it).
   */
  private beginSession(userId: string, mode: ActiveBattleMode, create: () => Promise<BattleSessionAdapter>): Promise<BattlePveSessionStepResult> {
    const registry = this.deps.activeBattles;
    return this.startGuard.run(this.session, async () => {
      const claim = await registry.claim(userId, this.roomId, mode);
      if (!claim.ok) {
        throw new AppError(ErrorCode.BATTLE_IN_PROGRESS, { fields: claim.active ? { activeBattle: activeBattleDto(claim.active) } : {} });
      }
      let session: BattleSessionAdapter;
      try {
        session = await create();
      } catch (error) {
        await registry.release(userId, this.roomId);
        throw error;
      }
      const first = session.start();
      this.session = session;
      this.sessionOwnerId = userId;
      await registry.attachBattle(userId, this.roomId, session.battleId);
      return first;
    });
  }

  /** Builds the response frame; settles rewards on the final frame (idempotent). */
  private async frameResponse(userId: string, requestId: string, step: BattlePveSessionStepResult) {
    const session = this.session!;
    const frame = {
      ok: step.accepted,
      requestId,
      error: step.error ?? null,
      ...buildBattleFrame(session.battleId, step),
    };

    if (!step.finished) return frame;
    // The player is no longer "in a battle" while looking at the result screen (friends, new starts elsewhere).
    void this.releaseSlot(userId);

    try {
      return { ...frame, result: await this.settle(userId, session, step) };
    } catch (error) {
      this.logger.error(`settling battle ${session.battleId} failed:`, error);
      // The battle is finished; the client can fetch the result later with `battle_result`.
      return { ...frame, result: null as null, resultError: error instanceof AppError ? error.errorCode : ErrorCode.SERVER_ERROR };
    }
  }

  /** Stage rewards for PvE sessions, rating + arena rewards for arena sessions (both idempotent per battle). */
  private settle(userId: string, session: BattleSessionAdapter, step: BattlePveSessionStepResult) {
    return session.mode === "arena"
      ? this.deps.arena.settle(userId, session.battleId, step.victory === true)
      : this.deps.battles.settleIfFinished(userId, session.battleId, step);
  }

  /**
   * Connection lost without leaving: a running battle keeps the player's seat for `reconnectSeconds` (nothing advances
   * meanwhile, PvE only moves on player input). Without a window (or once it expires) `onLeave` follows.
   */
  onDrop(client: Client, code?: number): void {
    const session = this.session;
    const userId = (client.auth as RoomIdentity | undefined)?.userId;
    const seconds = this.deps.reconnectSeconds();
    if (!session || session.finished || !userId || userId !== this.sessionOwnerId || seconds <= 0) return;

    this.logger.info(`battle ${session.battleId} (${session.mode}): player dropped (code ${code ?? "?"}), reconnection window ${seconds}s`);
    const droppedAt = Date.now();
    this.allowReconnection(client, seconds).then(
      () => this.logger.info(`battle ${session.battleId}: player reconnected after ${Math.round((Date.now() - droppedAt) / 1000)}s`),
      () => this.logger.info(`battle ${session.battleId}: reconnection window expired`),
    );
  }

  /** Leaving an arena battle without finishing it counts as a defeat (no escaping a lost fight). */
  async onLeave(_client: Client, _code?: number): Promise<void> {
    const session = this.session;
    const ownerId = this.sessionOwnerId;
    if (!session || !ownerId) return;
    await this.releaseSlot(ownerId);
    if (session.mode !== "arena") return;
    try {
      await this.deps.arena.settle(ownerId, session.battleId, session.lastResult?.finished ? session.lastResult.victory === true : false);
    } catch (error) {
      this.logger.error(`settling abandoned arena battle ${session.battleId} failed:`, error);
    }
  }

  async onDispose(): Promise<void> {
    if (this.sessionOwnerId) await this.releaseSlot(this.sessionOwnerId);
  }

  private async releaseSlot(userId: string): Promise<void> {
    try {
      await this.deps.activeBattles.release(userId, this.roomId);
    } catch (error) {
      this.logger.warn("releasing the active battle slot failed:", error);
    }
  }

  private requireSession(userId: string, battleId?: string): BattleSessionAdapter {
    if (!this.session || this.sessionOwnerId !== userId) throw new AppError(ErrorCode.BATTLE_NOT_STARTED);
    if (battleId && battleId !== this.session.battleId) throw new AppError(ErrorCode.BATTLE_ID_MISMATCH);
    return this.session;
  }

  private requireRunningSession(userId: string, battleId?: string): BattleSessionAdapter {
    const session = this.requireSession(userId, battleId);
    if (session.finished) throw new AppError(ErrorCode.BATTLE_ALREADY_FINISHED);
    return session;
  }
}
