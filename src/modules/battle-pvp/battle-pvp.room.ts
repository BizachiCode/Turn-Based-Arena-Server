import { CloseCode, ServerError, type Client, type Delayed } from "@colyseus/core";
import { Schema } from "@colyseus/schema";

import type { SocialConfig } from "../../config/SocialCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { ActiveBattleRegistry } from "../../shared/rooms/active-battles.js";
import { AuthenticatedRoom, type RoomIdentity } from "../../shared/rooms/authenticated-room.js";
import type { RequestFailure } from "../../shared/rooms/request-handler.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { FriendlyBattleService, FriendlyOutcome } from "../social/friendly.service.js";
import type { PlayerDirectory, PlayerSummary, SocialNotifier } from "../social/social.ports.js";
import { BattleCommandSchema, BattleRefSchema } from "../battle-pve/battle-pve.validation.js";
import { PvpTeamSchema, PvpEmptySchema } from "./battle-pvp.validation.js";
import type { PvpBattleSession, PvpStepResult } from "./pvp-battle-session.js";
import { buildPvpFrame } from "./pvp-frames.js";
import { PVP_SIDE_A, PVP_SIDE_B, type PvpSessionFactory, type PvpTeam } from "./pvp-session.factory.js";
import { verifyMatchTicket } from "./pvp-ticket.js";

export class BattlePvpState extends Schema {}

export type BattlePvpRoomDeps = {
  matches: Pick<FriendlyBattleService, "matchForRoom" | "matchEnded">;
  sessions: Pick<PvpSessionFactory, "validateTeam" | "create">;
  /** Fallback team when a player locked nothing in time: their arena defense. */
  defenses: { defenseOf(userId: string): Promise<{ uidsInSlots: string[]; leaderSlotIndex: number } | null> };
  directory: Pick<PlayerDirectory, "findPlayer">;
  activeBattles: ActiveBattleRegistry;
  /** Players not connected to the room yet hear about an abort through their presence connection. */
  notifier: SocialNotifier;
  rules: () => SocialConfig["friendlyBattle"];
  limiter: RateLimiter;
  /** Secret of the room creation ticket (`pvp-ticket.ts`). */
  ticketSecret: string;
};

type Phase = "lobby" | "prepare" | "battle" | "finished";

type Seat = {
  userId: string;
  sideId: string;
  player: PlayerSummary | null;
  client: Client | null;
  connected: boolean;
  /** Joined the room at least once. */
  joined: boolean;
  team: PvpTeam | null;
};

type CreateOptions = { matchId?: unknown; ticket?: unknown };

/** Error a busy player makes the room creation fail with (the friendly service maps it to FRIENDLY_*_BUSY). */
export const PVP_PLAYER_BUSY = "FRIENDLY_PLAYER_BUSY";
/** Seconds a finished / aborted room stays open so the clients get the last frame. */
const CLOSE_DELAY_MS = 15_000;
const ABORT_CLOSE_DELAY_MS = 2_000;

function requestIdOf(raw: unknown): string {
  const value = (raw as { requestId?: unknown } | null)?.requestId;
  return typeof value === "string" ? value : "";
}

function frameError(failure: RequestFailure, raw: unknown) {
  return { ok: false, requestId: requestIdOf(raw), error: failure.error, ...(failure.message ? { message: failure.message } : {}) };
}

/**
 * Room `battle_pvp`: one real-time friendly battle between two players, created by the server when a challenge is
 * accepted (a client cannot create it: the creation needs a ticket only the server can sign). Phases:
 * - `lobby`: both players join with `joinById(roomId, { accessToken })` within `joinTimeoutSeconds`, or the match is aborted;
 * - `prepare`: each player locks a team (`pvp/team`) within `prepareSeconds`; a missing team falls back to the arena
 *   defense, no team at all loses the match (`no_team`);
 * - `battle`: the server waits for the player whose unit must act (`turnSeconds`, then the AI plays the unit). Both
 *   players get every step as `battle_frame` (the acting player gets it as the request answer);
 * - `finished`: the last frame carries `result`; the room closes shortly after.
 * Disconnects keep the seat for `reconnectSeconds` (turns of the absent player are auto-played); not back in time =
 * loses by forfeit. Pushes: `pvp_state` (phase, deadlines, teams locked, connections), `battle_frame`, `pvp_aborted`.
 */
export class BattlePvpRoom extends AuthenticatedRoom<BattlePvpState, BattlePvpRoomDeps> {
  state = new BattlePvpState();
  private matchId = "";
  private phase: Phase = "lobby";
  private readonly seats = new Map<string, Seat>();
  private session: PvpBattleSession | null = null;
  private phaseDeadlineMs: number | null = null;
  private turnDeadlineMs: number | null = null;
  private phaseTimer: Delayed | null = null;
  private turnTimer: Delayed | null = null;
  private closeTimer: Delayed | null = null;
  private starting = false;
  private outcome: { winnerUserId: string | null; reason: string } | null = null;

  async onCreate(options: CreateOptions): Promise<void> {
    const { matches, activeBattles, directory, ticketSecret } = this.deps;
    if (!verifyMatchTicket(ticketSecret, options?.matchId, options?.ticket)) throw new ServerError(403, "battle_pvp rooms are created by the server");
    const matchId = options.matchId as string;
    const match = await matches.matchForRoom(matchId);
    if (!match || match.roomId) throw new ServerError(404, "match not available");
    this.matchId = matchId;

    this.maxClients = 2;
    this.autoDispose = false;
    await this.setPrivate(true);
    this.setMetadata({ matchId });

    const [challenger, target] = await Promise.all([directory.findPlayer(match.challengerId), directory.findPlayer(match.targetId)]);
    this.seats.set(match.challengerId, { userId: match.challengerId, sideId: PVP_SIDE_A, player: challenger, client: null, connected: false, joined: false, team: null });
    this.seats.set(match.targetId, { userId: match.targetId, sideId: PVP_SIDE_B, player: target, client: null, connected: false, joined: false, team: null });

    // Both players hold this battle from now on (no PvE start, friends see them "in battle").
    const claimed: string[] = [];
    for (const userId of [match.challengerId, match.targetId]) {
      const claim = await activeBattles.claim(userId, this.roomId, "pvp");
      if (!claim.ok) {
        for (const other of claimed) await activeBattles.release(other, this.roomId);
        this.seats.clear();
        throw new ServerError(409, `${PVP_PLAYER_BUSY}:${userId}`);
      }
      claimed.push(userId);
    }

    this.registerRequests();
    this.setPhaseTimer(this.deps.rules().joinTimeoutSeconds, () => void this.abort("join_timeout"));
  }

  private registerRequests(): void {
    const { limiter } = this.deps;

    this.handleAuthenticatedRequest("pvp/state", {
      schema: PvpEmptySchema,
      rateLimit: limiter,
      handle: ({ userId }) => ({ ok: true, ...this.stateFor(this.requireSeat(userId)) }),
    });

    this.handleAuthenticatedRequest("pvp/team", {
      schema: PvpTeamSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      handle: async ({ userId }, req) => {
        const seat = this.requireSeat(userId);
        if (this.phase !== "prepare" || this.starting) throw new AppError("PVP_NOT_PREPARING");
        const team: PvpTeam = { userId, uidsInSlots: req.uidsInSlots, leaderSlotIndex: req.leaderSlotIndex };
        await this.deps.sessions.validateTeam(team);
        if (this.phase !== "prepare" || this.starting) throw new AppError("PVP_NOT_PREPARING");
        seat.team = team;
        this.pushState();
        if ([...this.seats.values()].every((entry) => entry.team)) void this.startBattle();
        return { ok: true };
      },
    });

    this.handleAuthenticatedRequest("battle_command", {
      schema: BattleCommandSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => {
        const { seat, session } = this.requireBattle(userId, req.battleId);
        return this.playerStep(seat, req.requestId, session.useSkill(seat.sideId, { actorId: req.actorId, skillId: req.skillId, targetId: req.targetId }));
      },
    });

    this.handleAuthenticatedRequest("battle_auto", {
      schema: BattleRefSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => {
        const { seat, session } = this.requireBattle(userId, req.battleId);
        return this.playerStep(seat, req.requestId, session.auto(seat.sideId));
      },
    });

    this.handleAuthenticatedRequest("battle_surrender", {
      schema: BattleRefSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => {
        const { seat, session } = this.requireBattle(userId, req.battleId);
        this.outcome = null;
        return this.playerStep(seat, req.requestId, session.surrender(seat.sideId));
      },
    });

    // The current frame (after a reconnection): rebuild the scene from `state`, the events were already shown or lost.
    this.handleAuthenticatedRequest("battle_state", {
      schema: BattleRefSchema,
      invalidPayloadError: "INVALID_REQUEST",
      rateLimit: limiter,
      formatError: frameError,
      handle: ({ userId }, req) => {
        const seat = this.requireSeat(userId);
        const last = this.session?.lastResult;
        if (!this.session || !last) throw new AppError(ErrorCode.BATTLE_NOT_STARTED);
        if (req.battleId && req.battleId !== this.session.battleId) throw new AppError(ErrorCode.BATTLE_ID_MISMATCH);
        return { ok: true, requestId: req.requestId, error: null, snapshot: true, ...this.frameFor(seat, { ...last, events: [] }) };
      },
    });
  }

  // ── Connections ───────────────────────────────────────────────────

  onJoin(client: Client): void {
    const userId = (client.auth as RoomIdentity | undefined)?.userId ?? "";
    const seat = this.seats.get(userId);
    if (!seat) throw new ServerError(403, "not a player of this match");
    if (seat.client && seat.connected) throw new ServerError(409, "already in this match");
    if (this.phase === "finished") throw new ServerError(410, "match over");
    seat.client = client;
    seat.connected = true;
    seat.joined = true;
    this.pushState();
    if (this.phase === "lobby" && [...this.seats.values()].every((entry) => entry.joined)) this.enterPrepare();
  }

  onDrop(client: Client, code?: number): void {
    const seat = this.seatOf(client);
    if (!seat || this.phase === "finished") return;
    seat.connected = false;
    const seconds = this.deps.rules().reconnectSeconds;
    this.logger.info(`match ${this.matchId}: ${seat.sideId} dropped (code ${code ?? "?"}), window ${seconds}s`);
    this.pushState();
    if (seconds <= 0) return;
    this.allowReconnection(client, seconds).then(
      (fresh) => {
        seat.client = fresh;
        seat.connected = true;
        this.logger.info(`match ${this.matchId}: ${seat.sideId} reconnected`);
        this.pushState();
        // Back on their own turn: the regular turn timer replaces the short absent one.
        if (this.phase === "battle" && this.session?.awaitingSide() === seat.sideId) this.armTurnTimer(seat, true);
      },
      () => undefined,
    );
    if (this.phase === "battle" && this.session?.awaitingSide() === seat.sideId) this.armTurnTimer(seat, true);
  }

  /** Left for good: on purpose (`leave()`) or the reconnection window expired. */
  async onLeave(client: Client, code?: number): Promise<void> {
    const seat = this.seatOf(client);
    if (!seat) return;
    seat.client = null;
    seat.connected = false;
    const consented = code === CloseCode.CONSENTED;

    if (this.phase === "lobby" || this.phase === "prepare") {
      await this.abort(consented ? "player_left" : "player_disconnected");
      return;
    }
    if (this.phase === "battle" && this.session && !this.session.finished) {
      const other = [...this.seats.values()].find((entry) => entry !== seat)!;
      if (!other.connected) {
        await this.abort("both_disconnected");
        return;
      }
      this.outcome = { winnerUserId: other.userId, reason: consented ? "surrender" : "forfeit" };
      this.broadcastStep(this.session.surrender(seat.sideId));
      return;
    }
    if (this.phase === "finished" && ![...this.seats.values()].some((entry) => entry.connected)) this.closeSoon(0);
  }

  async onDispose(): Promise<void> {
    this.clearTimers();
    // A creation that was refused (no ticket, match not available, busy player) has nothing to close.
    if (!this.matchId || this.seats.size === 0) return;
    if (this.phase !== "finished") await this.abort("room_closed", false);
    await this.releaseSlots();
  }

  // ── Phases ────────────────────────────────────────────────────────

  private enterPrepare(): void {
    this.phase = "prepare";
    this.setPhaseTimer(this.deps.rules().prepareSeconds, () => void this.onPrepareTimeout());
    this.pushState();
  }

  /** Players who locked nothing get their arena defense; no team at all loses (both: aborted). */
  private async onPrepareTimeout(): Promise<void> {
    if (this.phase !== "prepare" || this.starting) return;
    this.starting = true;
    const missing: Seat[] = [];
    for (const seat of this.seats.values()) {
      if (seat.team) continue;
      const defense = await this.deps.defenses.defenseOf(seat.userId).catch((): null => null);
      if (defense) {
        const team: PvpTeam = { userId: seat.userId, uidsInSlots: defense.uidsInSlots, leaderSlotIndex: defense.leaderSlotIndex };
        try {
          await this.deps.sessions.validateTeam(team);
          seat.team = team;
          continue;
        } catch {
          // a defense unit was sold or moved: no usable team
        }
      }
      missing.push(seat);
    }
    this.starting = false;
    if (missing.length === 2) return void (await this.abort("no_team"));
    if (missing.length === 1) {
      const winner = [...this.seats.values()].find((seat) => seat !== missing[0])!;
      return void (await this.finishWithoutBattle(winner.userId, "no_team"));
    }
    await this.startBattle();
  }

  private async startBattle(): Promise<void> {
    if (this.phase !== "prepare" || this.starting) return;
    this.starting = true;
    this.clearTimers();
    const sideA = [...this.seats.values()].find((seat) => seat.sideId === PVP_SIDE_A)!;
    const sideB = [...this.seats.values()].find((seat) => seat.sideId === PVP_SIDE_B)!;
    try {
      this.session = await this.deps.sessions.create({ matchId: this.matchId, sideA: sideA.team!, sideB: sideB.team!, turnLimit: this.deps.rules().turnLimit });
    } catch (error) {
      this.starting = false;
      this.logger.warn(`match ${this.matchId}: battle setup failed:`, error);
      await this.abort("setup_failed");
      return;
    }
    this.phase = "battle";
    this.phaseDeadlineMs = null;
    this.starting = false;
    for (const seat of this.seats.values()) await this.deps.activeBattles.attachBattle(seat.userId, this.roomId, this.session.battleId).catch((): undefined => undefined);
    this.pushState();
    this.broadcastStep(this.session.start());
  }

  private async finishWithoutBattle(winnerUserId: string | null, reason: string): Promise<void> {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.clearTimers();
    this.outcome = { winnerUserId, reason };
    await this.recordEnd({ status: "finished", winnerId: winnerUserId, reason });
    this.pushState();
    this.closeSoon(CLOSE_DELAY_MS);
  }

  /** Ends the match without a result (nobody wins). */
  private async abort(reason: string, close = true): Promise<void> {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.clearTimers();
    this.outcome = { winnerUserId: null, reason };
    this.logger.info(`match ${this.matchId}: aborted (${reason})`);
    await this.recordEnd({ status: "aborted", winnerId: null, reason });
    this.broadcast("pvp_aborted", { matchId: this.matchId, reason });
    for (const seat of this.seats.values()) {
      if (seat.connected) continue;
      try {
        await this.deps.notifier.notify(seat.userId, { kind: "friendly_match_aborted", matchId: this.matchId, reason });
      } catch {
        // best effort
      }
    }
    if (close) this.closeSoon(ABORT_CLOSE_DELAY_MS);
  }

  // ── Battle steps ──────────────────────────────────────────────────

  /** Answers the acting player with their frame and pushes the step to the opponent. */
  private playerStep(seat: Seat, requestId: string, step: PvpStepResult) {
    if (!step.accepted) return { ok: false, requestId, ...this.frameFor(seat, step), error: step.error ?? null };
    this.afterStep(step);
    for (const other of this.seats.values()) if (other !== seat) this.sendFrame(other, step);
    return { ok: true, requestId, error: null, ...this.frameFor(seat, step) };
  }

  /** A server-side step (start, timer, absent player): every player gets it as a push. */
  private broadcastStep(step: PvpStepResult): void {
    if (!step.accepted && step.error) this.logger.warn(`match ${this.matchId}: step refused (${step.error})`);
    this.afterStep(step);
    for (const seat of this.seats.values()) this.sendFrame(seat, step);
  }

  /** Arms the turn timer of the next player (before the frames go out: they carry the deadline) or ends the match. */
  private afterStep(step: PvpStepResult): void {
    this.clearTurnTimer();
    if (step.finished) {
      void this.onBattleFinished(step);
      return;
    }
    const seat = [...this.seats.values()].find((entry) => entry.sideId === step.awaitingSideId);
    if (seat) this.armTurnTimer(seat, !seat.connected);
  }

  private armTurnTimer(seat: Seat, absent: boolean): void {
    this.clearTurnTimer();
    const rules = this.deps.rules();
    const seconds = absent && !seat.connected ? rules.absentTurnDelaySeconds : rules.turnSeconds;
    this.turnDeadlineMs = Date.now() + seconds * 1000;
    this.turnTimer = this.clock.setTimeout(() => this.autoPlay(seat), seconds * 1000);
  }

  private autoPlay(seat: Seat): void {
    this.turnTimer = null;
    if (this.phase !== "battle" || !this.session || this.session.awaitingSide() !== seat.sideId) return;
    this.broadcastStep(this.session.auto(seat.sideId));
  }

  private async onBattleFinished(step: PvpStepResult): Promise<void> {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.clearTimers();
    const winner = [...this.seats.values()].find((seat) => seat.sideId === step.winnerSideId) ?? null;
    if (!this.outcome) this.outcome = { winnerUserId: winner?.userId ?? null, reason: step.finishedReason ?? "finished" };
    // The last frame went out already; the state push carries the same result (clients waiting on the phase).
    this.pushState();
    await this.recordEnd({
      status: "finished",
      winnerId: this.outcome.winnerUserId,
      reason: this.outcome.reason,
      result: { battleId: step.state.battleId, turns: step.turn, rounds: step.round },
    });
    await this.releaseSlots();
    this.closeSoon(CLOSE_DELAY_MS);
  }

  // ── Frames and state ──────────────────────────────────────────────

  private frameFor(seat: Seat, step: PvpStepResult) {
    const mine = step.awaitingSideId === seat.sideId;
    const frame = buildPvpFrame(step, seat.sideId, {
      matchId: this.matchId,
      turnDeadlineUnix: step.awaitingSideId && this.turnDeadlineMs ? Math.ceil(this.turnDeadlineMs / 1000) : null,
    });
    const result = step.finished && this.outcome
      ? { friendly: true, victory: this.outcome.winnerUserId === seat.userId, winnerUserId: this.outcome.winnerUserId, reason: this.outcome.reason }
      : step.finished
        ? { friendly: true, victory: frame.victory === true, winnerUserId: [...this.seats.values()].find((entry) => entry.sideId === step.winnerSideId)?.userId ?? null, reason: step.finishedReason }
        : undefined;
    return { ...frame, awaitingPlayerInput: mine, ...(result ? { result } : {}) };
  }

  private sendFrame(seat: Seat, step: PvpStepResult): void {
    if (!seat.client || !seat.connected) return;
    seat.client.send("battle_frame", { ok: true, requestId: "", error: null, ...this.frameFor(seat, step) });
  }

  private stateFor(seat: Seat) {
    const other = [...this.seats.values()].find((entry) => entry !== seat)!;
    const describe = (entry: Seat) => ({
      userId: entry.userId,
      name: entry.player?.name ?? "",
      iconId: entry.player?.iconId ?? null,
      level: entry.player?.level ?? 1,
      sideId: entry.sideId,
      ready: !!entry.team,
      connected: entry.connected,
    });
    return {
      matchId: this.matchId,
      phase: this.phase,
      deadlineUnix: this.phaseDeadlineMs ? Math.ceil(this.phaseDeadlineMs / 1000) : null,
      battleId: this.session?.battleId ?? null,
      you: describe(seat),
      opponent: describe(other),
      result: this.phase === "finished" && this.outcome
        ? { friendly: true, victory: this.outcome.winnerUserId === seat.userId, winnerUserId: this.outcome.winnerUserId, reason: this.outcome.reason }
        : null,
    };
  }

  private pushState(): void {
    for (const seat of this.seats.values()) if (seat.client && seat.connected) seat.client.send("pvp_state", this.stateFor(seat));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private requireSeat(userId: string): Seat {
    const seat = this.seats.get(userId);
    if (!seat) throw new AppError(ErrorCode.FORBIDDEN);
    return seat;
  }

  private requireBattle(userId: string, battleId?: string | null): { seat: Seat; session: PvpBattleSession } {
    const seat = this.requireSeat(userId);
    if (!this.session) throw new AppError(ErrorCode.BATTLE_NOT_STARTED);
    if (battleId && battleId !== this.session.battleId) throw new AppError(ErrorCode.BATTLE_ID_MISMATCH);
    if (this.session.finished || this.phase !== "battle") throw new AppError(ErrorCode.BATTLE_ALREADY_FINISHED);
    return { seat, session: this.session };
  }

  private seatOf(client: Client): Seat | null {
    const userId = (client.auth as RoomIdentity | undefined)?.userId ?? "";
    return this.seats.get(userId) ?? null;
  }

  private setPhaseTimer(seconds: number, callback: () => void): void {
    this.phaseTimer?.clear();
    this.phaseDeadlineMs = Date.now() + seconds * 1000;
    this.phaseTimer = this.clock.setTimeout(callback, seconds * 1000);
  }

  private clearTurnTimer(): void {
    this.turnTimer?.clear();
    this.turnTimer = null;
    this.turnDeadlineMs = null;
  }

  private clearTimers(): void {
    this.phaseTimer?.clear();
    this.phaseTimer = null;
    this.phaseDeadlineMs = null;
    this.clearTurnTimer();
  }

  private closeSoon(delayMs: number): void {
    if (this.closeTimer) return;
    this.closeTimer = this.clock.setTimeout((): void => void this.disconnect(), delayMs);
  }

  private async recordEnd(outcome: FriendlyOutcome): Promise<void> {
    try {
      await this.deps.matches.matchEnded(this.matchId, outcome);
    } catch (error) {
      this.logger.error(`match ${this.matchId}: recording the end failed:`, error);
    }
  }

  private async releaseSlots(): Promise<void> {
    for (const seat of this.seats.values()) {
      try {
        await this.deps.activeBattles.release(seat.userId, this.roomId);
      } catch {
        // a zombie entry is cleared by the next lookup
      }
    }
  }
}
