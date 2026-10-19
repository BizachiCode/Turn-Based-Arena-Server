import { and, asc, count, desc, eq, inArray, like, or, sql } from "drizzle-orm";

import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import {
  arenaProfiles,
  friendships,
  guildMembers,
  guilds,
  userBlocks,
  userProfile,
  userSessions,
  users,
} from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import { escapeLike } from "../guild/guild.domain.js";
import { pairKeyOf } from "./social.domain.js";
import type {
  FriendsRepository,
  FriendshipRecord,
  FriendshipStatus,
  PlayerConnection,
  PlayerDirectory,
  PlayerSummary,
} from "./social.ports.js";

const playerColumns = {
  userId: userProfile.userId,
  name: userProfile.name,
  iconId: userProfile.iconId,
  level: userProfile.level,
};

const friendshipColumns = {
  id: friendships.id,
  requesterId: friendships.requesterId,
  addresseeId: friendships.addresseeId,
  status: friendships.status,
  createdAt: friendships.createdAt,
  respondedAt: friendships.respondedAt,
};

function toPlayer(row: { userId: string; name: string; iconId: string | null; level: number }): PlayerSummary {
  return { userId: row.userId, name: row.name, iconId: row.iconId || null, level: Math.max(1, Number(row.level) || 1) };
}

/** Players, friendships and blocks (Drizzle). */
export class DrizzleSocialRepository extends DrizzleRepository implements PlayerDirectory, FriendsRepository {
  constructor(database: Database) {
    super(database);
  }

  // ── Player directory ──────────────────────────────────────────────

  async findPlayer(userId: string): Promise<PlayerSummary | null> {
    const [row] = await this.database.select(playerColumns).from(userProfile).where(eq(userProfile.userId, userId)).limit(1);
    return row ? toPlayer(row) : null;
  }

  async findPlayerByName(name: string): Promise<PlayerSummary | null> {
    const [row] = await this.database.select(playerColumns).from(userProfile).where(eq(userProfile.name, name)).limit(1);
    return row ? toPlayer(row) : null;
  }

  async findPlayers(userIds: readonly string[]): Promise<PlayerSummary[]> {
    if (userIds.length === 0) return [];
    const rows = await this.database.select(playerColumns).from(userProfile).where(inArray(userProfile.userId, [...userIds]));
    return rows.map(toPlayer);
  }

  async searchByNamePrefix(prefix: string, limit: number): Promise<PlayerSummary[]> {
    const rows = await this.database.select(playerColumns).from(userProfile)
      .where(like(userProfile.name, `${escapeLike(prefix)}%`))
      .orderBy(sql`char_length(${userProfile.name})`, asc(userProfile.name))
      .limit(Math.max(1, limit));
    return rows.map(toPlayer);
  }

  async connectionsOf(userIds: readonly string[], onlineSince: Date): Promise<Map<string, PlayerConnection>> {
    const result = new Map<string, PlayerConnection>();
    if (userIds.length === 0) return result;
    const rows = await this.database
      .select({
        userId: userSessions.userId,
        // mapWith: Drizzle reads DATETIME as text; the column mapper parses it as UTC (new Date(text) would be local time).
        lastSeenAt: sql<Date | null>`max(${userSessions.lastHeartbeatAt})`.mapWith(userSessions.lastHeartbeatAt),
        online: sql<number>`max(case when ${userSessions.disconnectedAt} is null and ${userSessions.lastHeartbeatAt} > ${onlineSince} then 1 else 0 end)`,
      })
      .from(userSessions)
      .where(inArray(userSessions.userId, [...userIds]))
      .groupBy(userSessions.userId);
    for (const row of rows) {
      const seen = row.lastSeenAt ? new Date(row.lastSeenAt) : null;
      result.set(row.userId, { online: Number(row.online) === 1, lastSeenAt: seen && !Number.isNaN(seen.getTime()) ? seen : null });
    }
    return result;
  }

  async guildOf(userId: string): Promise<{ guildId: string; guildName: string } | null> {
    const [row] = await this.database.select({ guildId: guilds.id, guildName: guilds.name })
      .from(guildMembers).innerJoin(guilds, eq(guilds.id, guildMembers.guildId))
      .where(eq(guildMembers.userId, userId)).limit(1);
    return row ?? null;
  }

  async arenaOf(userId: string): Promise<{ rating: number; wins: number; losses: number } | null> {
    const [row] = await this.database.select({ rating: arenaProfiles.rating, wins: arenaProfiles.wins, losses: arenaProfiles.losses })
      .from(arenaProfiles).where(eq(arenaProfiles.userId, userId)).limit(1);
    return row ?? null;
  }

  // ── Friendships ───────────────────────────────────────────────────

  async lockPlayers(userIds: readonly string[], session: DbSession): Promise<void> {
    const ids = [...new Set(userIds)].sort();
    if (ids.length === 0) return;
    await this.db(session).select({ id: users.id }).from(users).where(inArray(users.id, ids)).orderBy(asc(users.id)).for("update");
  }

  async findBetween(a: string, b: string, session?: DbSession): Promise<FriendshipRecord | null> {
    const [row] = await this.db(session).select(friendshipColumns).from(friendships).where(eq(friendships.pairKey, pairKeyOf(a, b))).limit(1);
    return row ?? null;
  }

  async findById(id: string, session?: DbSession): Promise<FriendshipRecord | null> {
    const [row] = await this.db(session).select(friendshipColumns).from(friendships).where(eq(friendships.id, id)).limit(1);
    return row ?? null;
  }

  async insertRequest(record: FriendshipRecord, session: DbSession): Promise<void> {
    await this.db(session).insert(friendships).values({
      id: record.id,
      pairKey: pairKeyOf(record.requesterId, record.addresseeId),
      requesterId: record.requesterId,
      addresseeId: record.addresseeId,
      status: record.status,
      createdAt: record.createdAt,
      respondedAt: record.respondedAt,
    });
  }

  async accept(id: string, at: Date, session: DbSession): Promise<void> {
    await this.db(session).update(friendships).set({ status: "accepted", respondedAt: at }).where(eq(friendships.id, id));
  }

  async delete(id: string, session: DbSession): Promise<void> {
    await this.db(session).delete(friendships).where(eq(friendships.id, id));
  }

  async listOf(userId: string, status?: FriendshipStatus): Promise<FriendshipRecord[]> {
    const involved = or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId));
    return this.database.select(friendshipColumns).from(friendships)
      .where(status ? and(involved, eq(friendships.status, status)) : involved)
      .orderBy(desc(friendships.createdAt));
  }

  async countFriends(userId: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ value: count() }).from(friendships)
      .where(and(eq(friendships.status, "accepted"), or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))));
    return Number(row?.value ?? 0);
  }

  async countPending(userId: string, direction: "outgoing" | "incoming", session?: DbSession): Promise<number> {
    const column = direction === "outgoing" ? friendships.requesterId : friendships.addresseeId;
    const [row] = await this.db(session).select({ value: count() }).from(friendships)
      .where(and(eq(friendships.status, "pending"), eq(column, userId)));
    return Number(row?.value ?? 0);
  }

  // ── Blocks ────────────────────────────────────────────────────────

  async isBlocked(blockerId: string, blockedId: string, session?: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ id: userBlocks.blockedId }).from(userBlocks)
      .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId))).limit(1);
    return !!row;
  }

  async insertBlock(blockerId: string, blockedId: string, session: DbSession): Promise<void> {
    await this.db(session).insert(userBlocks).values({ blockerId, blockedId }).onDuplicateKeyUpdate({ set: { blockerId } });
  }

  async deleteBlock(blockerId: string, blockedId: string, session: DbSession): Promise<boolean> {
    return affectedRows(await this.db(session).delete(userBlocks)
      .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)))) > 0;
  }

  async listBlocked(blockerId: string): Promise<Array<{ userId: string; createdAt: Date }>> {
    return this.database.select({ userId: userBlocks.blockedId, createdAt: userBlocks.createdAt }).from(userBlocks)
      .where(eq(userBlocks.blockerId, blockerId)).orderBy(desc(userBlocks.createdAt));
  }

  async countBlocked(blockerId: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ value: count() }).from(userBlocks).where(eq(userBlocks.blockerId, blockerId));
    return Number(row?.value ?? 0);
  }
}
