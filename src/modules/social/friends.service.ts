// Friends: requests (auto-accepted when both players asked), friendships, blocks, player search and public profiles.
// Every change that concerns the other player is pushed to them as `social_event` after the commit.

import { ulid } from "ulid";

import type { SocialConfig } from "../../config/SocialCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { PlayerStatusReader } from "./player-status.js";
import {
  compareFriends,
  OFFLINE,
  otherOf,
  playerCard,
  relationOf,
  toUnix,
  type FriendDto,
  type FriendRequestDto,
  type PlayerCardDto,
  type Relation,
} from "./social.domain.js";
import type {
  FriendsRepository,
  FriendshipRecord,
  PlayerDirectory,
  PlayerSummary,
  SocialNotifier,
  UnreadMessages,
} from "./social.ports.js";

export type FriendsServiceDeps = {
  friends: FriendsRepository;
  directory: PlayerDirectory;
  status: PlayerStatusReader;
  notifier: SocialNotifier;
  uow: UnitOfWork;
  clock: Clock;
  config: () => SocialConfig;
  /** Unread private messages per friend (absent: 0). */
  unread?: UnreadMessages;
  /** Runs after a block was committed (e.g. cancels pending friendly challenges between the two). */
  onBlocked?: (blockerId: string, blockedId: string) => Promise<void> | void;
  newId?: () => string;
};

/** Target of a request: a user id (chat line, search result) or an exact profile name. */
export type PlayerTarget = { targetUserId?: string; name?: string };

type RequestOutcome =
  | { kind: "pending"; record: FriendshipRecord; created: boolean }
  | { kind: "accepted"; record: FriendshipRecord };

export class FriendsService {
  private readonly newId: () => string;

  constructor(private readonly deps: FriendsServiceDeps) {
    this.newId = deps.newId ?? ulid;
  }

  private rules() {
    const rules = this.deps.config().friends;
    if (!rules.enabled) throw new AppError(ErrorCode.FRIENDS_DISABLED);
    return rules;
  }

  // ── Reads ─────────────────────────────────────────────────────────

  /** Menu badge: pending incoming requests and unread private messages. */
  async summary(userId: string) {
    this.rules();
    const [incomingRequests, unread] = await Promise.all([
      this.deps.friends.countPending(userId, "incoming"),
      this.deps.unread?.unreadByPeer(userId) ?? Promise.resolve(new Map<string, number>()),
    ]);
    let unreadMessages = 0;
    for (const value of unread.values()) unreadMessages += value;
    return { ok: true, incomingRequests, unreadMessages };
  }

  async list(userId: string) {
    const rules = this.rules();
    const rows = await this.deps.friends.listOf(userId, "accepted");
    const friendIds = rows.map((row) => otherOf(row, userId));
    const [players, status, unread, incomingRequests] = await Promise.all([
      this.deps.directory.findPlayers(friendIds),
      this.deps.status.statusOf(friendIds),
      this.deps.unread?.unreadByPeer(userId) ?? Promise.resolve(new Map<string, number>()),
      this.deps.friends.countPending(userId, "incoming"),
    ]);
    const byId = new Map(players.map((player) => [player.userId, player]));
    const friends: FriendDto[] = [];
    for (const row of rows) {
      const player = byId.get(otherOf(row, userId));
      if (!player) continue;
      friends.push({
        ...playerCard(player, status.get(player.userId) ?? OFFLINE, "friend"),
        friendsSinceUnix: toUnix(row.respondedAt ?? row.createdAt),
        unread: unread.get(player.userId) ?? 0,
      });
    }
    friends.sort(compareFriends);
    return { ok: true, friends, maxFriends: rules.maxFriends, incomingRequests };
  }

  async requests(userId: string) {
    const rules = this.rules();
    const rows = await this.deps.friends.listOf(userId, "pending");
    const ids = rows.map((row) => otherOf(row, userId));
    const [players, status] = await Promise.all([this.deps.directory.findPlayers(ids), this.deps.status.statusOf(ids)]);
    const byId = new Map(players.map((player) => [player.userId, player]));
    const incoming: FriendRequestDto[] = [];
    const outgoing: FriendRequestDto[] = [];
    for (const row of rows) {
      const player = byId.get(otherOf(row, userId));
      if (!player) continue;
      const mine = row.requesterId === userId;
      const dto: FriendRequestDto = {
        requestId: row.id,
        direction: mine ? "outgoing" : "incoming",
        createdAtUnix: toUnix(row.createdAt),
        player: playerCard(player, status.get(player.userId) ?? OFFLINE, mine ? "pending_out" : "pending_in"),
      };
      (mine ? outgoing : incoming).push(dto);
    }
    return { ok: true, incoming, outgoing, maxPendingOutgoing: rules.maxPendingOutgoing };
  }

  /** Players whose name starts with `query` (at least `searchMinChars`), with the caller's relation to each. */
  async search(userId: string, query: string) {
    const rules = this.rules();
    const text = query.trim();
    if (text.length < rules.searchMinChars) return { ok: true, players: [] as PlayerCardDto[], minChars: rules.searchMinChars };
    const players = await this.deps.directory.searchByNamePrefix(text, rules.searchMaxResults);
    return { ok: true, players: await this.cards(userId, players), minChars: rules.searchMinChars };
  }

  /** Public profile of a player (any player may be looked up: what is shown is public anyway). */
  async profile(userId: string, targetUserId: string) {
    this.rules();
    const player = await this.deps.directory.findPlayer(targetUserId);
    if (!player) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    const [[card], guild, arena, friendCount] = await Promise.all([
      this.cards(userId, [player]),
      this.deps.directory.guildOf(targetUserId),
      this.deps.directory.arenaOf(targetUserId),
      this.deps.friends.countFriends(targetUserId),
    ]);
    return {
      ok: true,
      player: card,
      guildName: guild?.guildName ?? null,
      arena: arena ? { rating: arena.rating, wins: arena.wins, losses: arena.losses } : null,
      friendCount,
    };
  }

  async blocked(userId: string) {
    this.rules();
    const rows = await this.deps.friends.listBlocked(userId);
    const players = await this.deps.directory.findPlayers(rows.map((row) => row.userId));
    const byId = new Map(players.map((player) => [player.userId, player]));
    return {
      ok: true,
      players: rows.flatMap((row) => {
        const player = byId.get(row.userId);
        return player ? [{ userId: player.userId, name: player.name, iconId: player.iconId, level: player.level, blockedAtUnix: toUnix(row.createdAt) }] : [];
      }),
    };
  }

  /** Accepted friendship between the two players. */
  async areFriends(a: string, b: string): Promise<boolean> {
    return (await this.deps.friends.findBetween(a, b))?.status === "accepted";
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const [ab, ba] = await Promise.all([this.deps.friends.isBlocked(a, b), this.deps.friends.isBlocked(b, a)]);
    return ab || ba;
  }

  // ── Requests ──────────────────────────────────────────────────────

  /**
   * Sends a friend request. A pending request from the target is accepted instead (both asked); asking again while a
   * request is pending answers the same pending request.
   */
  async request(userId: string, target: PlayerTarget) {
    const rules = this.rules();
    const player = await this.resolveTarget(userId, target);
    await this.assertNotBlocked(userId, player.userId);
    const { friends, uow, clock } = this.deps;

    let outcome: RequestOutcome | null = null;
    try {
      await uow.transaction(async (tx) => {
        outcome = null;
        await friends.lockPlayers([userId, player.userId], tx);
        if (await friends.isBlocked(userId, player.userId, tx)) throw new AppError(ErrorCode.PLAYER_BLOCKED);
        if (await friends.isBlocked(player.userId, userId, tx)) throw new AppError(ErrorCode.FRIEND_REQUEST_REFUSED);

        const existing = await friends.findBetween(userId, player.userId, tx);
        if (existing?.status === "accepted") throw new AppError(ErrorCode.FRIEND_ALREADY);
        if (existing && existing.requesterId === userId) {
          outcome = { kind: "pending", record: existing, created: false };
          return;
        }
        if (existing) {
          await this.assertRoomForFriendship(userId, player.userId, tx);
          const now = clock.now();
          await friends.accept(existing.id, now, tx);
          outcome = { kind: "accepted", record: { ...existing, status: "accepted", respondedAt: now } };
          return;
        }

        if (await friends.countFriends(userId, tx) >= rules.maxFriends) throw new AppError(ErrorCode.FRIEND_LIST_FULL);
        if (await friends.countPending(userId, "outgoing", tx) >= rules.maxPendingOutgoing) throw new AppError(ErrorCode.FRIEND_TOO_MANY_REQUESTS);
        if (await friends.countPending(player.userId, "incoming", tx) >= rules.maxPendingIncoming) throw new AppError(ErrorCode.FRIEND_TARGET_REQUESTS_FULL);
        const record: FriendshipRecord = {
          id: this.newId(),
          requesterId: userId,
          addresseeId: player.userId,
          status: "pending",
          createdAt: clock.now(),
          respondedAt: null,
        };
        await friends.insertRequest(record, tx);
        outcome = { kind: "pending", record, created: true };
      });
    } catch (error) {
      // Both players asked at the same instant: the other insert won the pair key. Answer from the stored row.
      if (!isDuplicateKeyError(error)) throw error;
      const stored = await friends.findBetween(userId, player.userId);
      if (!stored) throw error;
      outcome = stored.status === "accepted" ? { kind: "accepted", record: stored } : { kind: "pending", record: stored, created: false };
    }

    const result = outcome as RequestOutcome | null;
    if (!result) throw new AppError(ErrorCode.SERVER_ERROR);
    const me = await this.deps.directory.findPlayer(userId);
    const [myStatus, theirStatus] = await this.statusPair(userId, player.userId);
    if (me && result.kind === "accepted") {
      await this.notify(player.userId, { kind: "friend_accepted", player: playerCard(me, myStatus, "friend") });
    } else if (me && result.kind === "pending" && result.created) {
      const request: FriendRequestDto = {
        requestId: result.record.id,
        direction: "incoming",
        createdAtUnix: toUnix(result.record.createdAt),
        player: playerCard(me, myStatus, "pending_in"),
      };
      await this.notify(player.userId, { kind: "friend_request", request });
    }
    const relation: Relation = result.kind === "accepted" ? "friend" : "pending_out";
    return { ok: true, relation, requestId: result.record.id, player: playerCard(player, theirStatus, relation) };
  }

  /** Accepts an incoming request (`requestId` from `friends/requests` or the push). */
  async accept(userId: string, requestId: string) {
    this.rules();
    const { friends, uow, clock } = this.deps;
    let accepted: FriendshipRecord | null = null;
    await uow.transaction(async (tx) => {
      accepted = null;
      const row = await friends.findById(requestId, tx);
      if (!row || row.status !== "pending" || row.addresseeId !== userId) throw new AppError(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
      await friends.lockPlayers([row.requesterId, row.addresseeId], tx);
      const locked = await friends.findById(requestId, tx);
      if (!locked || locked.status !== "pending" || locked.addresseeId !== userId) throw new AppError(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
      await this.assertRoomForFriendship(userId, locked.requesterId, tx);
      const now = clock.now();
      await friends.accept(locked.id, now, tx);
      accepted = { ...locked, status: "accepted", respondedAt: now };
    });

    const row = accepted as FriendshipRecord | null;
    if (!row) throw new AppError(ErrorCode.SERVER_ERROR);
    const [me, them] = await Promise.all([this.deps.directory.findPlayer(userId), this.deps.directory.findPlayer(row.requesterId)]);
    const [myStatus, theirStatus] = await this.statusPair(userId, row.requesterId);
    if (me) await this.notify(row.requesterId, { kind: "friend_accepted", player: playerCard(me, myStatus, "friend") });
    if (!them) return { ok: true, friend: null };
    const unread = (await this.deps.unread?.unreadByPeer(userId))?.get(row.requesterId) ?? 0;
    const friend: FriendDto = { ...playerCard(them, theirStatus, "friend"), friendsSinceUnix: toUnix(row.respondedAt), unread };
    return { ok: true, friend };
  }

  /** Declines an incoming request. The requester only sees the request disappear. */
  async reject(userId: string, requestId: string) {
    this.rules();
    const row = await this.deletePending(requestId, (record) => record.addresseeId === userId);
    await this.notify(row.requesterId, { kind: "friend_request_removed", requestId: row.id });
    return { ok: true };
  }

  /** Withdraws an outgoing request. */
  async cancel(userId: string, requestId: string) {
    this.rules();
    const row = await this.deletePending(requestId, (record) => record.requesterId === userId);
    await this.notify(row.addresseeId, { kind: "friend_request_removed", requestId: row.id });
    return { ok: true };
  }

  async remove(userId: string, targetUserId: string) {
    this.rules();
    const { friends, uow } = this.deps;
    await uow.transaction(async (tx) => {
      await friends.lockPlayers([userId, targetUserId], tx);
      const row = await friends.findBetween(userId, targetUserId, tx);
      if (!row || row.status !== "accepted") throw new AppError(ErrorCode.FRIEND_NOT_FOUND);
      await friends.delete(row.id, tx);
    });
    await this.notify(targetUserId, { kind: "friend_removed", userId });
    return { ok: true };
  }

  // ── Blocks ────────────────────────────────────────────────────────

  /**
   * Blocks a player: removes the friendship or pending request between the two, then refuses their requests, private
   * messages and challenges. The other player is told only that the friendship / request is gone.
   */
  async block(userId: string, targetUserId: string) {
    const rules = this.rules();
    if (targetUserId === userId) throw new AppError(ErrorCode.SOCIAL_SELF);
    if (!(await this.deps.directory.findPlayer(targetUserId))) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    const { friends, uow } = this.deps;

    let removed: FriendshipRecord | null = null;
    await uow.transaction(async (tx) => {
      removed = null;
      await friends.lockPlayers([userId, targetUserId], tx);
      if (await friends.isBlocked(userId, targetUserId, tx)) return;
      if (await friends.countBlocked(userId, tx) >= rules.maxBlocked) throw new AppError(ErrorCode.BLOCK_LIST_FULL);
      const row = await friends.findBetween(userId, targetUserId, tx);
      if (row) await friends.delete(row.id, tx);
      await friends.insertBlock(userId, targetUserId, tx);
      removed = row;
    });

    const row = removed as FriendshipRecord | null;
    if (row?.status === "accepted") await this.notify(targetUserId, { kind: "friend_removed", userId });
    else if (row) await this.notify(targetUserId, { kind: "friend_request_removed", requestId: row.id });
    try {
      await this.deps.onBlocked?.(userId, targetUserId);
    } catch {
      // the block itself is committed; the hook is best effort
    }
    return { ok: true };
  }

  async unblock(userId: string, targetUserId: string) {
    this.rules();
    await this.deps.uow.transaction((tx) => this.deps.friends.deleteBlock(userId, targetUserId, tx));
    return { ok: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private async resolveTarget(userId: string, target: PlayerTarget): Promise<PlayerSummary> {
    const player = target.targetUserId
      ? await this.deps.directory.findPlayer(target.targetUserId)
      : target.name ? await this.deps.directory.findPlayerByName(target.name.trim()) : null;
    if (!player) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    if (player.userId === userId) throw new AppError(ErrorCode.SOCIAL_SELF);
    return player;
  }

  private async assertNotBlocked(userId: string, targetId: string): Promise<void> {
    const { friends } = this.deps;
    if (await friends.isBlocked(userId, targetId)) throw new AppError(ErrorCode.PLAYER_BLOCKED);
    if (await friends.isBlocked(targetId, userId)) throw new AppError(ErrorCode.FRIEND_REQUEST_REFUSED);
  }

  /** Both lists must have room (checked under the players' row locks). */
  private async assertRoomForFriendship(userId: string, otherId: string, tx: DbSession): Promise<void> {
    const max = this.deps.config().friends.maxFriends;
    if (await this.deps.friends.countFriends(userId, tx) >= max) throw new AppError(ErrorCode.FRIEND_LIST_FULL);
    if (await this.deps.friends.countFriends(otherId, tx) >= max) throw new AppError(ErrorCode.FRIEND_TARGET_LIST_FULL);
  }

  private async deletePending(requestId: string, owns: (record: FriendshipRecord) => boolean): Promise<FriendshipRecord> {
    const { friends, uow } = this.deps;
    let deleted: FriendshipRecord | null = null;
    await uow.transaction(async (tx) => {
      deleted = null;
      const row = await friends.findById(requestId, tx);
      if (!row || row.status !== "pending" || !owns(row)) throw new AppError(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
      await friends.lockPlayers([row.requesterId, row.addresseeId], tx);
      const locked = await friends.findById(requestId, tx);
      if (!locked || locked.status !== "pending" || !owns(locked)) throw new AppError(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
      await friends.delete(locked.id, tx);
      deleted = locked;
    });
    const row = deleted as FriendshipRecord | null;
    if (!row) throw new AppError(ErrorCode.SERVER_ERROR);
    return row;
  }

  /** Cards of several players with the viewer's relation to each. */
  private async cards(viewerId: string, players: PlayerSummary[]): Promise<PlayerCardDto[]> {
    if (players.length === 0) return [];
    const ids = players.map((player) => player.userId);
    const [status, rows, blocked] = await Promise.all([
      this.deps.status.statusOf(ids),
      this.deps.friends.listOf(viewerId),
      this.deps.friends.listBlocked(viewerId),
    ]);
    const byOther = new Map(rows.map((row) => [otherOf(row, viewerId), row]));
    const blockedIds = new Set(blocked.map((row) => row.userId));
    return players.map((player) => playerCard(
      player,
      status.get(player.userId) ?? OFFLINE,
      relationOf(viewerId, player.userId, byOther.get(player.userId) ?? null, blockedIds.has(player.userId)),
    ));
  }

  private async statusPair(a: string, b: string) {
    const status = await this.deps.status.statusOf([a, b]);
    return [status.get(a) ?? OFFLINE, status.get(b) ?? OFFLINE] as const;
  }

  private async notify(userId: string, event: { kind: string } & Record<string, unknown>): Promise<void> {
    try {
      await this.deps.notifier.notify(userId, event);
    } catch {
      // best effort: the other client re-syncs with the requests
    }
  }
}
