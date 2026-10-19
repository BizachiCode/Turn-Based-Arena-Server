import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import {
  arenaProfiles,
  auditEvents,
  guildMembers,
  guilds,
  playerReports,
  userCharacterCapacity,
  userCharacters,
  userProfile,
  userRuneCapacity,
  userRunes,
  userSessions,
  userStageProgress,
  userStoryActive,
  userStoryProgress,
  userTowerProgress,
  users,
} from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import {
  PLAYER_FILTERS,
  type AdminAuditEntry,
  type AdminPlayerDetail,
  type AdminPlayerFilter,
  type AdminPlayerList,
  type AdminPlayerListQuery,
  type AdminPlayerRepository,
} from "./admin-players.ports.js";
import { likeContains, parseJsonMeta } from "./admin.repository.js";

/** Rows shown per list (the panel is an operator tool, not a full export). */
const MAX_UNITS = 1000;
const MAX_RUNES = 2000;

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export class DrizzleAdminPlayerRepository extends DrizzleRepository implements AdminPlayerRepository {
  constructor(database: Database) {
    super(database);
  }

  async loadDetail(userId: string): Promise<Omit<AdminPlayerDetail, "wallet" | "online"> | null> {
    const db = this.database;
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return null;

    const [profile, units, runeRows, runeCounts, capacity, runeCapacity, stages, towers, completed, active, guild, arena, connections] =
      await Promise.all([
        db.select({ name: userProfile.name, iconId: userProfile.iconId, level: userProfile.level, currentExp: userProfile.currentExp })
          .from(userProfile).where(eq(userProfile.userId, userId)).limit(1),
        db.select({
          uid: userCharacters.publicUid, characterId: userCharacters.characterId, stars: userCharacters.stars,
          level: userCharacters.level, awakeningIndex: userCharacters.awakeningIndex, location: userCharacters.location,
          locked: userCharacters.locked, createdAt: userCharacters.createdAt,
        }).from(userCharacters).where(eq(userCharacters.userId, userId))
          .orderBy(desc(userCharacters.stars), desc(userCharacters.level), userCharacters.id).limit(MAX_UNITS),
        db.select({
          uid: userRunes.publicUid, setId: userRunes.setId, slot: userRunes.slot, tier: userRunes.tier, quality: userRunes.quality,
          level: userRunes.level, mainStatType: userRunes.mainStatType, mainStatValue: userRunes.mainStatValue,
          equippedToUid: userRunes.equippedToUid,
        }).from(userRunes).where(eq(userRunes.userId, userId))
          .orderBy(desc(userRunes.quality), desc(userRunes.level), userRunes.id).limit(MAX_RUNES),
        db.select({ total: sql<number>`count(*)` }).from(userRunes).where(eq(userRunes.userId, userId)),
        db.select({ bag: userCharacterCapacity.bagCapacity, storage: userCharacterCapacity.storageCapacity })
          .from(userCharacterCapacity).where(eq(userCharacterCapacity.userId, userId)).limit(1),
        db.select({ capacity: userRuneCapacity.runeCapacity }).from(userRuneCapacity).where(eq(userRuneCapacity.userId, userId)).limit(1),
        db.select({
          regionId: userStageProgress.regionId, difficulty: userStageProgress.difficulty,
          cleared: sql<number>`sum(case when ${userStageProgress.clears} > 0 then 1 else 0 end)`,
          clears: sql<number>`sum(${userStageProgress.clears})`,
        }).from(userStageProgress).where(eq(userStageProgress.userId, userId))
          .groupBy(userStageProgress.regionId, userStageProgress.difficulty)
          .orderBy(userStageProgress.regionId, userStageProgress.difficulty),
        db.select({ regionId: userTowerProgress.regionId, seasonKey: userTowerProgress.seasonKey, clearedFloors: userTowerProgress.clearedFloors })
          .from(userTowerProgress).where(eq(userTowerProgress.userId, userId)).orderBy(desc(userTowerProgress.seasonKey)),
        db.select({ dialogueId: userStoryProgress.dialogueId, skipped: userStoryProgress.skipped, times: userStoryProgress.times, completedAt: userStoryProgress.completedAt })
          .from(userStoryProgress).where(eq(userStoryProgress.userId, userId)).orderBy(userStoryProgress.completedAt),
        db.select({ dialogueId: userStoryActive.dialogueId, step: userStoryActive.step })
          .from(userStoryActive).where(eq(userStoryActive.userId, userId)).limit(1),
        db.select({ guildId: guilds.id, name: guilds.name, role: guildMembers.role, joinedAt: guildMembers.joinedAt })
          .from(guildMembers).innerJoin(guilds, eq(guilds.id, guildMembers.guildId)).where(eq(guildMembers.userId, userId)).limit(1),
        db.select({
          rating: arenaProfiles.rating, wins: arenaProfiles.wins, losses: arenaProfiles.losses, defenseWins: arenaProfiles.defenseWins,
          defenseLosses: arenaProfiles.defenseLosses, season: arenaProfiles.season, seasonBattles: arenaProfiles.seasonBattles,
        }).from(arenaProfiles).where(eq(arenaProfiles.userId, userId)).limit(1),
        db.select({
          deviceId: userSessions.deviceId, room: userSessions.room, connectedAt: userSessions.connectedAt,
          lastHeartbeatAt: userSessions.lastHeartbeatAt, ip: userSessions.ip, userAgent: userSessions.userAgent,
        }).from(userSessions).where(and(eq(userSessions.userId, userId), isNull(userSessions.disconnectedAt)))
          .orderBy(desc(userSessions.lastHeartbeatAt)).limit(20),
      ]);

    const equippedPerUnit = new Map<string, number>();
    for (const rune of runeRows) if (rune.equippedToUid) equippedPerUnit.set(rune.equippedToUid, (equippedPerUnit.get(rune.equippedToUid) ?? 0) + 1);
    const now = Date.now();
    const banActive = user.isBanned === 1 && (!user.banExpiresAt || user.banExpiresAt.getTime() > now);

    return {
      account: {
        userId: user.id,
        username: user.username,
        email: user.isGuest ? null : user.email,
        isGuest: user.isGuest === 1,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: iso(user.lastLoginAt),
        failedLogins: user.failedLogins,
        lockedUntil: iso(user.lockedUntil),
        ban: user.isBanned === 1 ? { active: banActive, reason: user.banReason ?? null, until: iso(user.banExpiresAt) } : null,
        chatMute: user.chatMutedUntil
          ? { active: user.chatMutedUntil.getTime() > now, reason: user.chatMuteReason ?? null, until: user.chatMutedUntil.toISOString() }
          : null,
        deletionScheduledAt: iso(user.deletionScheduledAt),
      },
      profile: profile[0] ?? null,
      roster: {
        bagCapacity: capacity[0]?.bag ?? 0,
        storageCapacity: capacity[0]?.storage ?? 0,
        units: units.map((unit) => ({
          ...unit,
          locked: unit.locked === 1,
          runes: equippedPerUnit.get(unit.uid) ?? 0,
          createdAt: unit.createdAt.toISOString(),
        })),
      },
      runes: {
        capacity: runeCapacity[0]?.capacity ?? 0,
        total: Number(runeCounts[0]?.total ?? 0),
        items: runeRows,
      },
      stages: stages.map((row) => ({ ...row, cleared: Number(row.cleared ?? 0), clears: Number(row.clears ?? 0) })),
      towers,
      story: {
        completed: completed.map((row) => ({ ...row, skipped: row.skipped === 1, completedAt: row.completedAt.toISOString() })),
        active: active[0] ?? null,
      },
      guild: guild[0] ? { ...guild[0], joinedAt: guild[0].joinedAt.toISOString() } : null,
      arena: arena[0] ?? null,
      connections: connections.map((row) => ({ ...row, connectedAt: row.connectedAt.toISOString(), lastHeartbeatAt: row.lastHeartbeatAt.toISOString() })),
    };
  }

  async listPlayers(query: AdminPlayerListQuery): Promise<AdminPlayerList> {
    const db = this.database;
    const onlineSql = sql<number>`exists (select 1 from ${userSessions} where ${userSessions.userId} = ${users.id}
      and ${userSessions.disconnectedAt} is null and ${userSessions.lastHeartbeatAt} > ${query.onlineSince})`;
    const bannedSql = and(eq(users.isBanned, 1), or(isNull(users.banExpiresAt), gt(users.banExpiresAt, query.now)));
    const mutedSql = gt(users.chatMutedUntil, query.now);
    const tab: Record<AdminPlayerFilter, SQL | undefined> = {
      all: undefined,
      online: sql`${onlineSql}`,
      banned: bannedSql,
      muted: mutedSql,
      guests: eq(users.isGuest, 1),
      deletion: isNotNull(users.deletionScheduledAt),
      // At least one open player report against the account.
      reported: sql`exists (select 1 from ${playerReports} where ${playerReports.targetUserId} = ${users.id} and ${playerReports.status} = 'open')`,
    };

    const pattern = query.q ? likeContains(query.q) : null;
    const search = pattern
      ? or(like(users.id, pattern), like(users.username, pattern), like(users.email, pattern), like(userProfile.name, pattern))
      : undefined;
    const where = and(tab[query.filter], search);

    const sortColumn = {
      name: userProfile.name,
      level: userProfile.level,
      lastLogin: users.lastLoginAt,
      created: users.createdAt,
    }[query.sort];
    const order = query.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

    const [rows, totals, ...counters] = await Promise.all([
      db.select({
        userId: users.id, username: users.username, name: userProfile.name, email: users.email, level: userProfile.level,
        guild: guilds.name, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt, isGuest: users.isGuest,
        isBanned: users.isBanned, banExpiresAt: users.banExpiresAt, chatMutedUntil: users.chatMutedUntil,
        deletionScheduledAt: users.deletionScheduledAt, online: onlineSql,
      }).from(users)
        .leftJoin(userProfile, eq(userProfile.userId, users.id))
        .leftJoin(guildMembers, eq(guildMembers.userId, users.id))
        .leftJoin(guilds, eq(guilds.id, guildMembers.guildId))
        .where(where).orderBy(order, asc(users.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize),
      db.select({ total: sql<number>`count(*)` }).from(users).leftJoin(userProfile, eq(userProfile.userId, users.id)).where(where),
      ...PLAYER_FILTERS.map((filter) =>
        db.select({ total: sql<number>`count(*)` }).from(users).where(tab[filter])),
    ]);

    const counts = Object.fromEntries(PLAYER_FILTERS.map((filter, index) => [filter, Number(counters[index][0]?.total ?? 0)])) as AdminPlayerList["counts"];
    return {
      total: Number(totals[0]?.total ?? 0),
      counts,
      rows: rows.map((row) => ({
        userId: row.userId,
        username: row.username,
        name: row.name ?? null,
        email: row.isGuest === 1 ? null : row.email,
        level: row.level ?? null,
        guild: row.guild ?? null,
        lastLoginAt: iso(row.lastLoginAt),
        createdAt: row.createdAt.toISOString(),
        online: Number(row.online) === 1,
        banned: row.isBanned === 1 && (!row.banExpiresAt || row.banExpiresAt.getTime() > query.now.getTime()),
        muted: !!row.chatMutedUntil && row.chatMutedUntil.getTime() > query.now.getTime(),
        isGuest: row.isGuest === 1,
        deletionScheduledAt: iso(row.deletionScheduledAt),
      })),
    };
  }

  async auditTrail(userId: string, limit: number, beforeId?: number): Promise<AdminAuditEntry[]> {
    const where = beforeId ? and(eq(auditEvents.userId, userId), lt(auditEvents.id, beforeId)) : eq(auditEvents.userId, userId);
    const rows = await this.database.select().from(auditEvents).where(where).orderBy(desc(auditEvents.id)).limit(limit);
    return rows.map((row) => ({ id: row.id, kind: row.kind, meta: parseJsonMeta(row.meta), createdAt: row.createdAt.toISOString() }));
  }

  async setChatMute(userId: string, until: Date | null, reason: string | null): Promise<void> {
    await this.database.update(users).set({ chatMutedUntil: until, chatMuteReason: until ? reason : null }).where(eq(users.id, userId));
  }

  async chatMutedUntil(userId: string): Promise<Date | null> {
    const [row] = await this.database.select({ until: users.chatMutedUntil }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.until ?? null;
  }

  async resetStory(userId: string, dialogueIds: string[] | null, session: DbSession): Promise<number> {
    const db = this.db(session);
    const scope = dialogueIds ? and(eq(userStoryProgress.userId, userId), inArray(userStoryProgress.dialogueId, dialogueIds)) : eq(userStoryProgress.userId, userId);
    const result = await db.delete(userStoryProgress).where(scope);
    const activeScope = dialogueIds ? and(eq(userStoryActive.userId, userId), inArray(userStoryActive.dialogueId, dialogueIds)) : eq(userStoryActive.userId, userId);
    await db.delete(userStoryActive).where(activeScope);
    return affectedRows(result);
  }
}
