import { and, asc, count, desc, eq, gte, like, lt, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { guildJoinRequests, guildMembers, guilds, userProfile, users } from "../../infrastructure/database/schema/index.js";
import { escapeLike, type GuildJoinType, type GuildRole } from "./guild.domain.js";
import type {
  GuildApplicantRow,
  GuildListRow,
  GuildMemberProfile,
  GuildMemberRecord,
  GuildOwnRequestRow,
  GuildPatch,
  GuildRecord,
  GuildRepository,
  GuildRequestRecord,
  PlayerProfileRow,
} from "./guild.ports.js";

const guildColumns = {
  id: guilds.id,
  name: guilds.name,
  description: guilds.description,
  notice: guilds.notice,
  iconId: guilds.iconId,
  tagsJson: guilds.tagsJson,
  joinType: guilds.joinType,
  minLevel: guilds.minLevel,
  memberCount: guilds.memberCount,
  createdAt: guilds.createdAt,
};

const memberColumns = {
  userId: guildMembers.userId,
  guildId: guildMembers.guildId,
  publicId: guildMembers.publicId,
  role: guildMembers.role,
  joinedAt: guildMembers.joinedAt,
};

type GuildRow = { [K in keyof typeof guildColumns]: (typeof guildColumns)[K]["_"]["data"] };

/** Tag ids as stored; malformed rows read as "no tags". */
function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function toGuild({ tagsJson, ...row }: GuildRow): GuildRecord {
  return { ...row, joinType: row.joinType as GuildJoinType, tags: parseTags(tagsJson) };
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Leader name of a guild (subquery of the list/details views). Static SQL with explicit aliases: Drizzle leaves column
 * references unqualified in single-table selects, which would be ambiguous inside the subquery.
 */
const leaderName = sql<string>`coalesce((select lp.name from guild_members lm
  inner join user_profile lp on lp.user_id = lm.user_id
  where lm.guild_id = guilds.id and lm.role = 'leader' limit 1), '')`;

export class DrizzleGuildRepository extends DrizzleRepository implements GuildRepository {
  constructor(database: Database) {
    super(database);
  }

  // ── Members ───────────────────────────────────────────────────────────

  async findMembership(userId: string, session?: DbSession, forUpdate = false): Promise<GuildMemberRecord | null> {
    const query = this.db(session).select(memberColumns).from(guildMembers).where(eq(guildMembers.userId, userId)).limit(1);
    const [row] = await (forUpdate ? query.for("update") : query);
    return row ? { ...row, role: row.role as GuildRole } : null;
  }

  async findMemberByPublicId(guildId: string, publicId: string, session: DbSession): Promise<GuildMemberRecord | null> {
    const [row] = await this.db(session).select(memberColumns).from(guildMembers)
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.publicId, publicId))).limit(1).for("update");
    return row ? { ...row, role: row.role as GuildRole } : null;
  }

  async listMembers(guildId: string, session?: DbSession, forUpdate = false): Promise<GuildMemberRecord[]> {
    const query = this.db(session).select(memberColumns).from(guildMembers)
      .where(eq(guildMembers.guildId, guildId)).orderBy(asc(guildMembers.joinedAt), asc(guildMembers.userId));
    const rows = await (forUpdate ? query.for("update") : query);
    return rows.map((row) => ({ ...row, role: row.role as GuildRole }));
  }

  async listMemberProfiles(guildId: string, onlineSince: Date): Promise<GuildMemberProfile[]> {
    const rows = await this.database.select({
      ...memberColumns,
      name: userProfile.name,
      level: userProfile.level,
      iconId: userProfile.iconId,
      lastLoginAt: users.lastLoginAt,
      lastHeartbeatAt: sql<unknown>`(select max(us.last_heartbeat_at) from user_sessions us where us.user_id = guild_members.user_id)`,
      online: sql<number>`exists(select 1 from user_sessions us where us.user_id = guild_members.user_id
        and us.disconnected_at is null and us.last_heartbeat_at > ${onlineSince})`,
    }).from(guildMembers)
      .innerJoin(userProfile, eq(userProfile.userId, guildMembers.userId))
      .innerJoin(users, eq(users.id, guildMembers.userId))
      .where(eq(guildMembers.guildId, guildId))
      .orderBy(asc(guildMembers.joinedAt), asc(guildMembers.userId));

    return rows.map(({ lastLoginAt, lastHeartbeatAt, online, ...row }) => {
      const heartbeat = toDate(lastHeartbeatAt);
      const lastActiveAt = heartbeat && (!lastLoginAt || heartbeat > lastLoginAt) ? heartbeat : lastLoginAt ?? null;
      return { ...row, role: row.role as GuildRole, lastActiveAt, online: Number(online) === 1 };
    });
  }

  async insertMember(member: Omit<GuildMemberRecord, "joinedAt">, session: DbSession): Promise<void> {
    await this.db(session).insert(guildMembers).values(member);
  }

  async deleteMember(userId: string, session: DbSession): Promise<void> {
    await this.db(session).delete(guildMembers).where(eq(guildMembers.userId, userId));
  }

  async setRole(userId: string, role: GuildRole, session: DbSession): Promise<void> {
    await this.db(session).update(guildMembers).set({ role }).where(eq(guildMembers.userId, userId));
  }

  // ── Guilds ────────────────────────────────────────────────────────────

  async findGuild(guildId: string, session?: DbSession, forUpdate = false): Promise<GuildRecord | null> {
    const query = this.db(session).select(guildColumns).from(guilds).where(eq(guilds.id, guildId)).limit(1);
    const [row] = await (forUpdate ? query.for("update") : query);
    return row ? toGuild(row) : null;
  }

  async findGuildRow(guildId: string): Promise<GuildListRow | null> {
    const [row] = await this.database.select({ ...guildColumns, leaderName }).from(guilds).where(eq(guilds.id, guildId)).limit(1);
    return row ? { ...toGuild(row), leaderName: row.leaderName ?? "" } : null;
  }

  async isNameTaken(nameKey: string, session?: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ id: guilds.id }).from(guilds).where(eq(guilds.nameKey, nameKey)).limit(1);
    return !!row;
  }

  async insertGuild(
    guild: Omit<GuildRecord, "createdAt" | "memberCount"> & { nameKey: string; memberCount: number },
    session: DbSession,
  ): Promise<void> {
    const { tags, ...values } = guild;
    await this.db(session).insert(guilds).values({ ...values, tagsJson: JSON.stringify(tags) });
  }

  async updateGuild(guildId: string, patch: GuildPatch, session: DbSession): Promise<void> {
    const { tags, ...values } = patch;
    const set = { ...values, ...(tags ? { tagsJson: JSON.stringify(tags) } : {}) };
    if (Object.keys(set).length === 0) return;
    await this.db(session).update(guilds).set(set).where(eq(guilds.id, guildId));
  }

  async renameGuild(guildId: string, name: string, nameKey: string, session: DbSession): Promise<void> {
    await this.db(session).update(guilds).set({ name, nameKey }).where(eq(guilds.id, guildId));
  }

  async addMemberCount(guildId: string, delta: number, session: DbSession): Promise<void> {
    await this.db(session).update(guilds)
      .set({ memberCount: sql`greatest(0, ${guilds.memberCount} + ${delta})` })
      .where(eq(guilds.id, guildId));
  }

  async deleteGuild(guildId: string, session: DbSession): Promise<void> {
    await this.db(session).delete(guilds).where(eq(guilds.id, guildId));
  }

  async listGuilds(filter: { search: string | null; playerLevel: number; maxMembers: number; limit: number }): Promise<GuildListRow[]> {
    const base = this.database.select({ ...guildColumns, leaderName }).from(guilds);

    const rows = filter.search
      ? await base.where(like(guilds.nameKey, `%${escapeLike(filter.search.toLowerCase())}%`))
        .orderBy(asc(guilds.nameKey)).limit(filter.limit)
      : await base.orderBy(
        asc(sql`${guilds.memberCount} >= ${filter.maxMembers}`),
        asc(sql`${guilds.minLevel} > ${filter.playerLevel}`),
        asc(sql`${guilds.joinType} = 'approval'`),
        desc(guilds.memberCount),
        desc(guilds.createdAt),
        asc(guilds.id),
      ).limit(filter.limit);

    return rows.map((row) => ({ ...toGuild(row), leaderName: row.leaderName ?? "" }));
  }

  // ── Join requests ─────────────────────────────────────────────────────

  async findRequest(requestId: string, session: DbSession, forUpdate = false): Promise<GuildRequestRecord | null> {
    const query = this.db(session).select({
      id: guildJoinRequests.id,
      guildId: guildJoinRequests.guildId,
      userId: guildJoinRequests.userId,
      createdAt: guildJoinRequests.createdAt,
    }).from(guildJoinRequests).where(eq(guildJoinRequests.id, requestId)).limit(1);
    const [row] = await (forUpdate ? query.for("update") : query);
    return row ?? null;
  }

  async findRequestFor(guildId: string, userId: string, session?: DbSession): Promise<GuildRequestRecord | null> {
    const [row] = await this.db(session).select({
      id: guildJoinRequests.id,
      guildId: guildJoinRequests.guildId,
      userId: guildJoinRequests.userId,
      createdAt: guildJoinRequests.createdAt,
    }).from(guildJoinRequests)
      .where(and(eq(guildJoinRequests.guildId, guildId), eq(guildJoinRequests.userId, userId))).limit(1);
    return row ?? null;
  }

  async insertRequest(request: Omit<GuildRequestRecord, "createdAt">, session: DbSession): Promise<void> {
    await this.db(session).insert(guildJoinRequests).values(request);
  }

  async deleteRequest(requestId: string, session: DbSession): Promise<void> {
    await this.db(session).delete(guildJoinRequests).where(eq(guildJoinRequests.id, requestId));
  }

  async deleteRequestsOfUser(userId: string, session: DbSession): Promise<void> {
    await this.db(session).delete(guildJoinRequests).where(eq(guildJoinRequests.userId, userId));
  }

  async deleteExpiredRequestsOfUser(userId: string, before: Date, session: DbSession): Promise<void> {
    await this.db(session).delete(guildJoinRequests)
      .where(and(eq(guildJoinRequests.userId, userId), lt(guildJoinRequests.createdAt, before)));
  }

  async countRequestsOfUser(userId: string, since: Date, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ value: count() }).from(guildJoinRequests)
      .where(and(eq(guildJoinRequests.userId, userId), gte(guildJoinRequests.createdAt, since)));
    return Number(row?.value ?? 0);
  }

  async listRequestsOfUser(userId: string, since: Date): Promise<GuildOwnRequestRow[]> {
    return this.database.select({
      guildId: guilds.id,
      name: guilds.name,
      iconId: guilds.iconId,
      memberCount: guilds.memberCount,
      createdAt: guildJoinRequests.createdAt,
    }).from(guildJoinRequests)
      .innerJoin(guilds, eq(guilds.id, guildJoinRequests.guildId))
      .where(and(eq(guildJoinRequests.userId, userId), gte(guildJoinRequests.createdAt, since)))
      .orderBy(desc(guildJoinRequests.createdAt), asc(guildJoinRequests.id));
  }

  async listRequestsOfGuild(guildId: string, since: Date): Promise<GuildApplicantRow[]> {
    return this.database.select({
      id: guildJoinRequests.id,
      name: userProfile.name,
      level: userProfile.level,
      iconId: userProfile.iconId,
      createdAt: guildJoinRequests.createdAt,
    }).from(guildJoinRequests)
      .innerJoin(userProfile, eq(userProfile.userId, guildJoinRequests.userId))
      .where(and(eq(guildJoinRequests.guildId, guildId), gte(guildJoinRequests.createdAt, since)))
      .orderBy(asc(guildJoinRequests.createdAt), asc(guildJoinRequests.id));
  }

  async countRequestsOfGuild(guildId: string, since: Date): Promise<number> {
    const [row] = await this.database.select({ value: count() }).from(guildJoinRequests)
      .where(and(eq(guildJoinRequests.guildId, guildId), gte(guildJoinRequests.createdAt, since)));
    return Number(row?.value ?? 0);
  }

  // ── Profiles ──────────────────────────────────────────────────────────

  async profileOf(userId: string, session?: DbSession): Promise<PlayerProfileRow | null> {
    const [row] = await this.db(session).select({ name: userProfile.name, level: userProfile.level, iconId: userProfile.iconId })
      .from(userProfile).where(eq(userProfile.userId, userId)).limit(1);
    return row ?? null;
  }
}
