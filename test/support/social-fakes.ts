// In-memory fakes of the social ports (players, friendships, blocks) and a recording notifier.

import { setSocialConfig, SocialConfigSchema, type SocialConfig } from "../../src/config/SocialCatalog";
import { FixedClock } from "../../src/shared/kernel/clock";
import type { DbSession } from "../../src/shared/kernel/unit-of-work";
import { PlayerStatusReader } from "../../src/modules/social/player-status";
import { pairKeyOf } from "../../src/modules/social/social.domain";
import type {
  FriendsRepository,
  FriendshipRecord,
  FriendshipStatus,
  PlayerConnection,
  PlayerDirectory,
  PlayerSummary,
  SocialEvent,
  SocialNotifier,
} from "../../src/modules/social/social.ports";
import { duplicateKeyError, InMemoryUnitOfWork } from "./fakes";

export const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

export class InMemorySocialRepository implements PlayerDirectory, FriendsRepository {
  players = new Map<string, PlayerSummary>();
  connections = new Map<string, PlayerConnection>();
  guilds = new Map<string, { guildId: string; guildName: string }>();
  arena = new Map<string, { rating: number; wins: number; losses: number }>();
  rows: FriendshipRecord[] = [];
  blocks: Array<{ blockerId: string; blockedId: string; createdAt: Date }> = [];
  locks: string[][] = [];

  addPlayer(userId: string, name = userId, level = 10): PlayerSummary {
    const player = { userId, name, iconId: `icon_${userId}`, level };
    this.players.set(userId, player);
    return player;
  }

  snapshot() {
    return { rows: this.rows.map((row) => ({ ...row })), blocks: this.blocks.map((row) => ({ ...row })) };
  }

  restore(state: unknown) {
    const value = state as ReturnType<InMemorySocialRepository["snapshot"]>;
    this.rows = value.rows;
    this.blocks = value.blocks;
  }

  // directory
  async findPlayer(userId: string) { return this.players.get(userId) ?? null; }
  async findPlayerByName(name: string) {
    return [...this.players.values()].find((player) => player.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  async findPlayers(userIds: readonly string[]) { return userIds.flatMap((id) => this.players.get(id) ?? []); }
  async searchByNamePrefix(prefix: string, limit: number) {
    return [...this.players.values()]
      .filter((player) => player.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  async connectionsOf(userIds: readonly string[]) {
    return new Map(userIds.flatMap((id) => (this.connections.has(id) ? [[id, this.connections.get(id)!] as const] : [])));
  }
  async guildOf(userId: string) { return this.guilds.get(userId) ?? null; }
  async arenaOf(userId: string) { return this.arena.get(userId) ?? null; }

  // friendships
  async lockPlayers(userIds: readonly string[], _session: DbSession) { this.locks.push([...new Set(userIds)].sort()); }
  async findBetween(a: string, b: string) {
    const key = pairKeyOf(a, b);
    return this.rows.find((row) => pairKeyOf(row.requesterId, row.addresseeId) === key) ?? null;
  }
  async findById(id: string) { return this.rows.find((row) => row.id === id) ?? null; }
  async insertRequest(record: FriendshipRecord) {
    if (await this.findBetween(record.requesterId, record.addresseeId)) throw duplicateKeyError();
    this.rows.push({ ...record });
  }
  async accept(id: string, at: Date) {
    const row = this.rows.find((entry) => entry.id === id);
    if (row) { row.status = "accepted"; row.respondedAt = at; }
  }
  async delete(id: string) { this.rows = this.rows.filter((row) => row.id !== id); }
  async listOf(userId: string, status?: FriendshipStatus) {
    return this.rows.filter((row) => (row.requesterId === userId || row.addresseeId === userId) && (!status || row.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async countFriends(userId: string) { return (await this.listOf(userId, "accepted")).length; }
  async countPending(userId: string, direction: "outgoing" | "incoming") {
    return this.rows.filter((row) => row.status === "pending" && (direction === "outgoing" ? row.requesterId : row.addresseeId) === userId).length;
  }

  // blocks
  async isBlocked(blockerId: string, blockedId: string) { return this.blocks.some((row) => row.blockerId === blockerId && row.blockedId === blockedId); }
  async insertBlock(blockerId: string, blockedId: string) {
    if (!(await this.isBlocked(blockerId, blockedId))) this.blocks.push({ blockerId, blockedId, createdAt: new Date(T0) });
  }
  async deleteBlock(blockerId: string, blockedId: string) {
    const before = this.blocks.length;
    this.blocks = this.blocks.filter((row) => !(row.blockerId === blockerId && row.blockedId === blockedId));
    return this.blocks.length < before;
  }
  async listBlocked(blockerId: string) { return this.blocks.filter((row) => row.blockerId === blockerId).map((row) => ({ userId: row.blockedId, createdAt: row.createdAt })); }
  async countBlocked(blockerId: string) { return this.blocks.filter((row) => row.blockerId === blockerId).length; }
}

export class RecordingNotifier implements SocialNotifier {
  events: Array<{ userId: string; event: SocialEvent }> = [];
  notify(userId: string, event: SocialEvent) { this.events.push({ userId, event }); }
  kinds(userId?: string) { return this.events.filter((entry) => !userId || entry.userId === userId).map((entry) => entry.event.kind); }
  clear() { this.events = []; }
}

/** Live battles for `PlayerStatusReader` (`inBattle`). */
export class FakeBattles {
  live = new Set<string>();
  async findMany(userIds: readonly string[]) { return new Map(userIds.filter((id) => this.live.has(id)).map((id) => [id, {}] as const)); }
}

export function socialConfig(patch: { friends?: Partial<SocialConfig["friends"]>; directMessages?: Partial<SocialConfig["directMessages"]>; friendlyBattle?: Partial<SocialConfig["friendlyBattle"]> } = {}): SocialConfig {
  const config = SocialConfigSchema.parse({ friends: patch.friends ?? {}, directMessages: patch.directMessages ?? {}, friendlyBattle: patch.friendlyBattle ?? {} });
  setSocialConfig(config);
  return config;
}

export function socialKit(config: SocialConfig = socialConfig()) {
  const repo = new InMemorySocialRepository();
  const clock = new FixedClock(T0);
  const notifier = new RecordingNotifier();
  const battles = new FakeBattles();
  const uow = new InMemoryUnitOfWork().register(repo);
  const status = new PlayerStatusReader(repo, battles, clock, () => config.friends.onlineWindowSeconds);
  let counter = 0;
  const newId = () => `F${String(++counter).padStart(25, "0")}`;
  return { repo, clock, notifier, battles, uow, status, newId, config: () => config };
}

/** In-memory private messages (same contract as DrizzleDmRepository). */
export class InMemoryDmRepository {
  lines: Array<{ id: number; senderId: string; recipientId: string; message: string; originalMessage: string | null; createdAt: Date }> = [];
  threadRows = new Map<string, { userId: string; peerId: string; lastMessageId: number; lastAt: Date; unread: number; lastReadId: number }>();
  private nextId = 1;
  constructor(private readonly clock: { now(): Date }) {}

  private thread(userId: string, peerId: string) {
    const key = `${userId}>${peerId}`;
    let row = this.threadRows.get(key);
    if (!row) {
      row = { userId, peerId, lastMessageId: 0, lastAt: new Date(0), unread: 0, lastReadId: 0 };
      this.threadRows.set(key, row);
    }
    return row;
  }

  async insertMessage(row: { senderId: string; recipientId: string; message: string; original: string | null }, cap: number) {
    const line = { id: this.nextId++, senderId: row.senderId, recipientId: row.recipientId, message: row.message, originalMessage: row.original, createdAt: this.clock.now() };
    this.lines.push(line);
    const mine = this.thread(row.senderId, row.recipientId);
    Object.assign(mine, { lastMessageId: line.id, lastAt: line.createdAt, lastReadId: Math.max(mine.lastReadId, line.id) });
    const theirs = this.thread(row.recipientId, row.senderId);
    Object.assign(theirs, { lastMessageId: line.id, lastAt: line.createdAt, unread: theirs.unread + 1 });
    const key = pairKeyOf(row.senderId, row.recipientId);
    const conversation = this.lines.filter((entry) => pairKeyOf(entry.senderId, entry.recipientId) === key);
    if (conversation.length > cap) {
      const dropped = new Set(conversation.slice(0, conversation.length - cap).map((entry) => entry.id));
      this.lines = this.lines.filter((entry) => !dropped.has(entry.id));
    }
    return line;
  }

  async history(userId: string, peerId: string, beforeId: number | null, limit: number) {
    const key = pairKeyOf(userId, peerId);
    const rows = this.lines.filter((entry) => pairKeyOf(entry.senderId, entry.recipientId) === key && (!beforeId || entry.id < beforeId));
    return rows.slice(Math.max(0, rows.length - limit));
  }

  async threads(userId: string, limit: number) {
    return [...this.threadRows.values()].filter((row) => row.userId === userId)
      .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime() || b.lastMessageId - a.lastMessageId).slice(0, limit)
      .map(({ peerId, lastMessageId, lastAt, unread }) => ({ peerId, lastMessageId, lastAt, unread }));
  }

  async messagesById(ids: readonly number[]) { return this.lines.filter((line) => ids.includes(line.id)); }

  async markRead(userId: string, peerId: string, upToId: number) {
    const row = this.threadRows.get(`${userId}>${peerId}`);
    if (!row) return 0;
    row.lastReadId = Math.max(row.lastReadId, upToId);
    row.unread = this.lines.filter((line) => line.senderId === peerId && line.recipientId === userId && line.id > row.lastReadId).length;
    return row.unread;
  }

  async findMessage(id: number) { return this.lines.find((line) => line.id === id) ?? null; }

  async unreadByPeer(userId: string) {
    return new Map([...this.threadRows.values()].filter((row) => row.userId === userId && row.unread > 0).map((row) => [row.peerId, row.unread] as const));
  }
}

/** In-memory friendly matches (same contract as DrizzleFriendlyMatchRepository). */
export class InMemoryFriendlyMatchRepository {
  rows: Array<import("../../src/modules/social/friendly.ports").FriendlyMatchRecord & { result?: unknown }> = [];

  async insert(record: import("../../src/modules/social/friendly.ports").FriendlyMatchRecord) { this.rows.push({ ...record }); }
  async findById(id: string) { const row = this.rows.find((entry) => entry.id === id); return row ? { ...row } : null; }
  async listOpen(userId: string) {
    return this.rows.filter((row) => (row.challengerId === userId || row.targetId === userId) && (row.status === "pending" || row.status === "accepted"))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((row) => ({ ...row }));
  }
  async pendingFrom(challengerId: string) { return this.rows.filter((row) => row.challengerId === challengerId && row.status === "pending").map((row) => ({ ...row })); }
  async pendingBetween(a: string, b: string) {
    return this.rows.filter((row) => row.status === "pending" && ((row.challengerId === a && row.targetId === b) || (row.challengerId === b && row.targetId === a))).map((row) => ({ ...row }));
  }
  async expireStale(userIds: readonly string[], now: Date) {
    for (const row of this.rows) {
      if (row.status === "pending" && row.expiresAt < now && (userIds.includes(row.challengerId) || userIds.includes(row.targetId))) row.status = "expired";
    }
  }
  async transition(id: string, from: readonly string[], to: import("../../src/modules/social/friendly.ports").FriendlyMatchStatus, patch: import("../../src/modules/social/friendly.ports").FriendlyMatchPatch) {
    const row = this.rows.find((entry) => entry.id === id);
    if (!row || !from.includes(row.status)) return false;
    row.status = to;
    Object.assign(row, patch);
    return true;
  }
}
