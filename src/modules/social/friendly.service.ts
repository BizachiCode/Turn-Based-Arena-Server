// Friendly battles: challenge a friend (or a guild mate when allowed) who is online and not in a battle; the target
// accepts within `challengeTtlSeconds` and the server creates the real-time match room (`battle_pvp`) for both.
// No cost, no rewards, no rating. Every step is pushed to the other player as `social_event`.

import { ulid } from "ulid";

import type { SocialConfig } from "../../config/SocialCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { FriendlyMatchRecord, FriendlyMatchRepository } from "./friendly.ports.js";
import type { PlayerStatusReader } from "./player-status.js";
import { OFFLINE, playerCard, toUnix, type PlayerCardDto, type PlayerStatusInfo } from "./social.domain.js";
import type { FriendsRepository, PlayerDirectory, PlayerSummary, SocialNotifier } from "./social.ports.js";

export type FriendlyChallengeDto = {
  challengeId: string;
  direction: "incoming" | "outgoing";
  /** The other player. */
  player: PlayerCardDto;
  createdAtUnix: number;
  expiresAtUnix: number;
};

export type FriendlyMatchDto = { matchId: string; roomId: string; opponent: PlayerCardDto };

/** Creates the match room on the server (`battle_pvp`); rejects when the room refused (a player is busy). */
export interface FriendlyRoomGateway {
  createMatchRoom(matchId: string): Promise<string>;
  /** The match room still runs (false after a server restart or a crash: the match can never finish). */
  roomExists(roomId: string): Promise<boolean>;
}

/** Thrown by the room gateway when the room refused because a player is already in a battle. */
export class FriendlyRoomBusyError extends Error {
  constructor(readonly userId: string) {
    super("FRIENDLY_PLAYER_BUSY");
  }
}

export type FriendlyBattleServiceDeps = {
  matches: FriendlyMatchRepository;
  friendships: Pick<FriendsRepository, "findBetween" | "isBlocked" | "lockPlayers">;
  directory: PlayerDirectory;
  status: PlayerStatusReader;
  notifier: SocialNotifier;
  rooms: FriendlyRoomGateway;
  uow: UnitOfWork;
  clock: Clock;
  config: () => SocialConfig;
  newId?: () => string;
};

export type FriendlyOutcome = {
  status: "finished" | "aborted";
  winnerId: string | null;
  reason: string;
  result?: unknown;
};

export class FriendlyBattleService {
  private readonly newId: () => string;

  constructor(private readonly deps: FriendlyBattleServiceDeps) {
    this.newId = deps.newId ?? ulid;
  }

  private rules() {
    const rules = this.deps.config().friendlyBattle;
    if (!rules.enabled) throw new AppError(ErrorCode.FRIENDLY_DISABLED);
    return rules;
  }

  /** Pending challenges (both directions) and the running match of the player. */
  async list(userId: string) {
    this.rules();
    await this.deps.matches.expireStale([userId], this.deps.clock.now());
    const rows = await this.deps.matches.listOpen(userId);
    const otherIds = rows.map((row) => (row.challengerId === userId ? row.targetId : row.challengerId));
    const [players, status] = await Promise.all([this.deps.directory.findPlayers(otherIds), this.deps.status.statusOf(otherIds)]);
    const byId = new Map(players.map((player) => [player.userId, player]));
    const incoming: FriendlyChallengeDto[] = [];
    const outgoing: FriendlyChallengeDto[] = [];
    let match: FriendlyMatchDto | null = null;
    for (const row of rows) {
      const otherId = row.challengerId === userId ? row.targetId : row.challengerId;
      const other = byId.get(otherId);
      if (!other) continue;
      const card = playerCard(other, status.get(otherId) ?? OFFLINE, "none");
      if (row.status === "accepted") {
        if (await this.isStale(row)) {
          await this.deps.matches.transition(row.id, ["accepted"], "aborted", { finishedAt: this.deps.clock.now(), finishedReason: "room_gone" });
          continue;
        }
        if (!match && row.roomId) match = { matchId: row.id, roomId: row.roomId, opponent: card };
        continue;
      }
      const dto = this.challengeDto(row, userId, card);
      (dto.direction === "incoming" ? incoming : outgoing).push(dto);
    }
    return { ok: true, incoming, outgoing, match, challengeTtlSeconds: this.deps.config().friendlyBattle.challengeTtlSeconds };
  }

  /**
   * An accepted match whose room is gone (server restarted or crashed) or that never got a room: it can never finish,
   * so `list` aborts it instead of offering a rejoin that would fail.
   */
  private async isStale(row: FriendlyMatchRecord): Promise<boolean> {
    if (row.roomId) return !(await this.deps.rooms.roomExists(row.roomId));
    const rules = this.deps.config().friendlyBattle;
    const since = row.respondedAt ?? row.createdAt;
    return this.deps.clock.now().getTime() - since.getTime() > (rules.joinTimeoutSeconds + rules.prepareSeconds) * 1000;
  }

  /**
   * Challenges a player. A challenge the target already sent to the caller is answered instead (direction
   * `incoming`, the client offers to accept it); a second challenge to the same player answers the pending one; any
   * other outgoing challenge of the caller is cancelled (one at a time).
   */
  async send(userId: string, targetUserId: string) {
    const rules = this.rules();
    const target = await this.requirePlayer(userId, targetUserId);
    await this.assertAllowed(userId, targetUserId);
    const [mine, theirs] = await this.statusPair(userId, targetUserId);
    if (mine.status === "in_battle") throw new AppError(ErrorCode.FRIENDLY_BUSY);
    if (theirs.status === "in_battle") throw new AppError(ErrorCode.FRIENDLY_TARGET_BUSY);
    if (theirs.status !== "online") throw new AppError(ErrorCode.FRIENDLY_TARGET_OFFLINE);

    const { matches, uow, clock } = this.deps;
    await matches.expireStale([userId, targetUserId], clock.now());

    let challenge: FriendlyMatchRecord | null = null;
    let reused = false;
    const cancelled: FriendlyMatchRecord[] = [];
    await uow.transaction(async (tx) => {
      challenge = null;
      reused = false;
      cancelled.length = 0;
      await this.deps.friendships.lockPlayers([userId, targetUserId], tx);
      const between = await matches.pendingBetween(userId, targetUserId, tx);
      const existing = between[0];
      if (existing) {
        challenge = existing;
        reused = true;
        return;
      }
      for (const other of await matches.pendingFrom(userId, tx)) {
        if (await matches.transition(other.id, ["pending"], "cancelled", { respondedAt: clock.now() }, tx)) cancelled.push(other);
      }
      const now = clock.now();
      const record: FriendlyMatchRecord = {
        id: this.newId(),
        challengerId: userId,
        targetId: targetUserId,
        status: "pending",
        roomId: null,
        winnerId: null,
        finishedReason: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + rules.challengeTtlSeconds * 1000),
        respondedAt: null,
        finishedAt: null,
      };
      await matches.insert(record, tx);
      challenge = record;
    });

    const row = challenge as FriendlyMatchRecord | null;
    if (!row) throw new AppError(ErrorCode.SERVER_ERROR);
    for (const other of cancelled) await this.notify(other.targetId, { kind: "friendly_challenge_cancelled", challengeId: other.id });
    if (!reused) {
      const me = await this.deps.directory.findPlayer(userId);
      if (me) await this.notify(targetUserId, { kind: "friendly_challenge", challenge: this.challengeDto(row, targetUserId, playerCard(me, mine, "none")) });
    }
    return { ok: true, challenge: this.challengeDto(row, userId, playerCard(target, theirs, "none")) };
  }

  /** The target accepts: both players are re-checked, the match room is created and the challenger is told where. */
  async accept(userId: string, challengeId: string) {
    this.rules();
    const { matches, clock } = this.deps;
    const row = await matches.findById(challengeId);
    if (!row || row.status !== "pending" || row.targetId !== userId) throw new AppError(ErrorCode.FRIENDLY_CHALLENGE_NOT_FOUND);
    if (row.expiresAt.getTime() <= clock.nowMs()) {
      await matches.transition(row.id, ["pending"], "expired", {});
      throw new AppError(ErrorCode.FRIENDLY_CHALLENGE_EXPIRED);
    }
    await this.assertAllowed(userId, row.challengerId);
    const challenger = await this.requirePlayer(userId, row.challengerId);
    const [mine, theirs] = await this.statusPair(userId, row.challengerId);
    if (mine.status === "in_battle") throw new AppError(ErrorCode.FRIENDLY_BUSY);
    if (theirs.status === "in_battle") throw new AppError(ErrorCode.FRIENDLY_TARGET_BUSY);
    if (theirs.status !== "online") throw new AppError(ErrorCode.FRIENDLY_TARGET_OFFLINE);

    if (!(await matches.transition(row.id, ["pending"], "accepted", { respondedAt: clock.now() }))) {
      throw new AppError(ErrorCode.FRIENDLY_CHALLENGE_NOT_FOUND);
    }

    let roomId: string;
    try {
      roomId = await this.deps.rooms.createMatchRoom(row.id);
    } catch (error) {
      await matches.transition(row.id, ["accepted"], "aborted", { finishedAt: clock.now(), finishedReason: "room_failed" });
      await this.notify(row.challengerId, { kind: "friendly_match_aborted", matchId: row.id, reason: "room_failed" });
      if (error instanceof FriendlyRoomBusyError) {
        throw new AppError(error.userId === userId ? ErrorCode.FRIENDLY_BUSY : ErrorCode.FRIENDLY_TARGET_BUSY);
      }
      throw new AppError(ErrorCode.FRIENDLY_MATCH_FAILED);
    }
    await matches.transition(row.id, ["accepted"], "accepted", { roomId });

    const me = await this.deps.directory.findPlayer(userId);
    if (me) await this.notify(row.challengerId, { kind: "friendly_match", matchId: row.id, roomId, opponent: playerCard(me, mine, "none") });
    const match: FriendlyMatchDto = { matchId: row.id, roomId, opponent: playerCard(challenger, theirs, "none") };
    return { ok: true, match };
  }

  async decline(userId: string, challengeId: string) {
    this.rules();
    const row = await this.deps.matches.findById(challengeId);
    if (!row || row.targetId !== userId || !(await this.deps.matches.transition(row.id, ["pending"], "declined", { respondedAt: this.deps.clock.now() }))) {
      throw new AppError(ErrorCode.FRIENDLY_CHALLENGE_NOT_FOUND);
    }
    await this.notify(row.challengerId, { kind: "friendly_challenge_declined", challengeId: row.id });
    return { ok: true };
  }

  async cancel(userId: string, challengeId: string) {
    this.rules();
    const row = await this.deps.matches.findById(challengeId);
    if (!row || row.challengerId !== userId || !(await this.deps.matches.transition(row.id, ["pending"], "cancelled", { respondedAt: this.deps.clock.now() }))) {
      throw new AppError(ErrorCode.FRIENDLY_CHALLENGE_NOT_FOUND);
    }
    await this.notify(row.targetId, { kind: "friendly_challenge_cancelled", challengeId: row.id });
    return { ok: true };
  }

  // ── Match room hooks ──────────────────────────────────────────────

  /** The accepted match a `battle_pvp` room is created for (null when it is not accepted). */
  async matchForRoom(matchId: string): Promise<FriendlyMatchRecord | null> {
    const row = await this.deps.matches.findById(matchId);
    return row && row.status === "accepted" ? row : null;
  }

  /** Records the end of a match (exactly once: a finished / aborted match never changes again). */
  async matchEnded(matchId: string, outcome: FriendlyOutcome): Promise<boolean> {
    return this.deps.matches.transition(matchId, ["accepted"], outcome.status, {
      winnerId: outcome.winnerId,
      finishedReason: outcome.reason.slice(0, 32),
      finishedAt: this.deps.clock.now(),
      result: outcome.result ?? null,
    });
  }

  /** A block cancels the pending challenges between the two players. */
  async cancelBetween(a: string, b: string): Promise<void> {
    for (const row of await this.deps.matches.pendingBetween(a, b)) {
      if (!(await this.deps.matches.transition(row.id, ["pending"], "cancelled", { respondedAt: this.deps.clock.now() }))) continue;
      const other = row.challengerId === a ? row.targetId : row.challengerId;
      await this.notify(other, { kind: row.challengerId === other ? "friendly_challenge_declined" : "friendly_challenge_cancelled", challengeId: row.id });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private async requirePlayer(userId: string, otherId: string): Promise<PlayerSummary> {
    if (otherId === userId) throw new AppError(ErrorCode.SOCIAL_SELF);
    const player = await this.deps.directory.findPlayer(otherId);
    if (!player) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    return player;
  }

  /** Friends (or guild mates when allowed) that no block separates. */
  private async assertAllowed(userId: string, otherId: string): Promise<void> {
    const { friendships, directory } = this.deps;
    const [ab, ba, friendship] = await Promise.all([
      friendships.isBlocked(userId, otherId),
      friendships.isBlocked(otherId, userId),
      friendships.findBetween(userId, otherId),
    ]);
    if (ab || ba) throw new AppError(ErrorCode.FRIENDLY_NOT_ALLOWED);
    if (friendship?.status === "accepted") return;
    if (this.deps.config().friendlyBattle.allowGuildMembers) {
      const [mine, theirs] = await Promise.all([directory.guildOf(userId), directory.guildOf(otherId)]);
      if (mine && theirs && mine.guildId === theirs.guildId) return;
    }
    throw new AppError(ErrorCode.FRIENDLY_NOT_ALLOWED);
  }

  private async statusPair(a: string, b: string): Promise<[PlayerStatusInfo, PlayerStatusInfo]> {
    const status = await this.deps.status.statusOf([a, b]);
    return [status.get(a) ?? OFFLINE, status.get(b) ?? OFFLINE];
  }

  private challengeDto(row: FriendlyMatchRecord, viewerId: string, other: PlayerCardDto): FriendlyChallengeDto {
    return {
      challengeId: row.id,
      direction: row.targetId === viewerId ? "incoming" : "outgoing",
      player: other,
      createdAtUnix: toUnix(row.createdAt),
      expiresAtUnix: toUnix(row.expiresAt),
    };
  }

  private async notify(userId: string, event: { kind: string } & Record<string, unknown>): Promise<void> {
    try {
      await this.deps.notifier.notify(userId, event);
    } catch {
      // best effort: the client re-syncs with challenge/list
    }
  }
}
