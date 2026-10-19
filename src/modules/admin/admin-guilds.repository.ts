import { and, asc, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { guildActivity, guildJoinRequests, guildMembers, guilds, userProfile, users } from "../../infrastructure/database/schema/index.js";
import {
  GUILD_FILTERS,
  type AdminGuildDetail,
  type AdminGuildFilter,
  type AdminGuildList,
  type AdminGuildListQuery,
  type AdminGuildRepository,
  type AdminGuildRow,
} from "./admin-guilds.ports.js";
import { likeContains } from "./admin.repository.js";

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export class DrizzleAdminGuildRepository extends DrizzleRepository implements AdminGuildRepository {
  constructor(database: Database) {
    super(database);
  }

  async list(query: AdminGuildListQuery): Promise<AdminGuildList> {
    const db = this.database;
    const tab: Record<AdminGuildFilter, SQL | undefined> = {
      all: undefined,
      open: eq(guilds.joinType, "open"),
      approval: eq(guilds.joinType, "approval"),
    };
    const pattern = query.q ? likeContains(query.q) : null;
    const where = and(tab[query.filter], pattern ? or(like(guilds.name, pattern), like(guilds.id, pattern)) : undefined);

    const activity = sql<number>`coalesce((select sum(${guildActivity.points}) from ${guildActivity} where ${guildActivity.guildId} = ${guilds.id}), 0)`;
    const sortColumn = {
      name: guilds.name,
      members: guilds.memberCount,
      created: guilds.createdAt,
      minLevel: guilds.minLevel,
      activity,
    }[query.sort];
    const order = query.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

    const [rows, totals, ...counters] = await Promise.all([
      db.select({
        guildId: guilds.id, name: guilds.name, memberCount: guilds.memberCount, joinType: guilds.joinType, minLevel: guilds.minLevel,
        createdAt: guilds.createdAt, leaderUserId: guildMembers.userId, leaderName: userProfile.name, activityPoints: activity,
      }).from(guilds)
        .leftJoin(guildMembers, and(eq(guildMembers.guildId, guilds.id), eq(guildMembers.role, "leader")))
        .leftJoin(userProfile, eq(userProfile.userId, guildMembers.userId))
        .where(where).orderBy(order, asc(guilds.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize),
      db.select({ total: sql<number>`count(*)` }).from(guilds).where(where),
      ...GUILD_FILTERS.map((filter) => db.select({ total: sql<number>`count(*)` }).from(guilds).where(tab[filter])),
    ]);

    const counts = Object.fromEntries(GUILD_FILTERS.map((filter, index) => [filter, Number(counters[index][0]?.total ?? 0)])) as AdminGuildList["counts"];
    return {
      total: Number(totals[0]?.total ?? 0),
      counts,
      rows: rows.map((row) => ({
        guildId: row.guildId,
        name: row.name,
        memberCount: row.memberCount,
        leaderName: row.leaderName ?? null,
        leaderUserId: row.leaderUserId ?? null,
        joinType: row.joinType,
        minLevel: row.minLevel,
        activityPoints: Number(row.activityPoints ?? 0),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async detail(guildId: string): Promise<AdminGuildDetail | null> {
    const db = this.database;
    const [guild] = await db.select().from(guilds).where(eq(guilds.id, guildId)).limit(1);
    if (!guild) return null;

    const [members, activity, requests] = await Promise.all([
      db.select({
        userId: guildMembers.userId, publicId: guildMembers.publicId, role: guildMembers.role, joinedAt: guildMembers.joinedAt,
        name: userProfile.name, level: userProfile.level, lastLoginAt: users.lastLoginAt,
      }).from(guildMembers)
        .innerJoin(users, eq(users.id, guildMembers.userId))
        .leftJoin(userProfile, eq(userProfile.userId, guildMembers.userId))
        .where(eq(guildMembers.guildId, guildId)).orderBy(asc(guildMembers.joinedAt), asc(guildMembers.userId)),
      db.select({ points: sql<number>`coalesce(sum(${guildActivity.points}), 0)` }).from(guildActivity).where(eq(guildActivity.guildId, guildId)),
      db.select({ total: sql<number>`count(*)` }).from(guildJoinRequests).where(eq(guildJoinRequests.guildId, guildId)),
    ]);

    const leader = members.find((member) => member.role === "leader");
    let tags: string[] = [];
    try {
      const parsed = guild.tagsJson ? JSON.parse(guild.tagsJson) : [];
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch { /* malformed tags are shown as none */ }

    const row: AdminGuildRow = {
      guildId: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
      leaderName: leader?.name ?? null,
      leaderUserId: leader?.userId ?? null,
      joinType: guild.joinType,
      minLevel: guild.minLevel,
      activityPoints: Number(activity[0]?.points ?? 0),
      createdAt: guild.createdAt.toISOString(),
    };
    return {
      guild: { ...row, description: guild.description, notice: guild.notice, iconId: guild.iconId, tags },
      members: members.map((member) => ({
        userId: member.userId,
        publicId: member.publicId,
        name: member.name ?? null,
        level: member.level ?? null,
        role: member.role,
        joinedAt: member.joinedAt.toISOString(),
        lastLoginAt: iso(member.lastLoginAt),
      })),
      pendingRequests: Number(requests[0]?.total ?? 0),
    };
  }
}
