import { and, asc, desc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import type { Database } from "../../infrastructure/database/drizzle.js";
import {
  arenaProfiles,
  guildActivity,
  guildMembers,
  guilds,
  userCharacters,
  userProfile,
  users,
  userStageProgress,
  userTowerProgress,
} from "../../infrastructure/database/schema/index.js";
import { levelScore, type PlayerMetric } from "./ranking.domain.js";
import type {
  GuildScoreRow,
  GuildStanding,
  RankingProfile,
  RankingRepository,
  RankingScoreRow,
  RankingStanding,
} from "./ranking.ports.js";

/** A metric that sums / counts rows per player. */
type AggregateSpec = { table: MySqlTable; userCol: AnyMySqlColumn; value: SQL<number>; where: SQL | undefined };

const notBanned = eq(users.isBanned, 0);

/** Drizzle implementation of the leaderboard queries (read only, parameterized, banned players excluded). */
export class DrizzleRankingRepository implements RankingRepository {
  constructor(private readonly database: Database) {}

  async topScores(metric: PlayerMetric, limit: number): Promise<RankingScoreRow[]> {
    if (metric.kind === "level") {
      const rows = await this.database.select({ userId: userProfile.userId, level: userProfile.level, exp: userProfile.currentExp })
        .from(userProfile).innerJoin(users, eq(users.id, userProfile.userId))
        .where(notBanned)
        .orderBy(desc(userProfile.level), desc(userProfile.currentExp), asc(userProfile.userId))
        .limit(limit);
      return rows.map((row) => ({ userId: row.userId, value: row.level, score: levelScore(row.level, row.exp) }));
    }

    if (metric.kind === "arena") {
      const rows = await this.database.select({ userId: arenaProfiles.userId, rating: arenaProfiles.rating })
        .from(arenaProfiles).innerJoin(users, eq(users.id, arenaProfiles.userId))
        .where(notBanned)
        .orderBy(desc(arenaProfiles.rating), asc(arenaProfiles.updatedAt), asc(arenaProfiles.userId))
        .limit(limit);
      return rows.map((row) => ({ userId: row.userId, value: row.rating, score: row.rating }));
    }

    const spec = this.aggregate(metric);
    if (!spec) return [];
    const rows = await this.database.select({ userId: spec.userCol, total: spec.value.mapWith(Number) })
      .from(spec.table).innerJoin(users, eq(users.id, spec.userCol))
      .where(and(spec.where, notBanned))
      .groupBy(spec.userCol)
      .having(sql`${spec.value} > 0`)
      .orderBy(desc(spec.value), asc(spec.userCol))
      .limit(limit);
    return rows.map((row) => ({ userId: String(row.userId), value: row.total, score: row.total }));
  }

  async standing(metric: PlayerMetric, userId: string): Promise<RankingStanding | null> {
    if (metric.kind === "level") {
      const [mine] = await this.database.select({ level: userProfile.level, exp: userProfile.currentExp })
        .from(userProfile).where(eq(userProfile.userId, userId)).limit(1);
      if (!mine) return null;
      const [ahead] = await this.database.select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(userProfile).innerJoin(users, eq(users.id, userProfile.userId))
        .where(and(notBanned, or(gt(userProfile.level, mine.level), and(eq(userProfile.level, mine.level), gt(userProfile.currentExp, mine.exp)))));
      return { value: mine.level, score: levelScore(mine.level, mine.exp), better: ahead?.n ?? 0 };
    }

    if (metric.kind === "arena") {
      const [mine] = await this.database.select({ rating: arenaProfiles.rating }).from(arenaProfiles).where(eq(arenaProfiles.userId, userId)).limit(1);
      if (!mine) return null;
      const [ahead] = await this.database.select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(arenaProfiles).innerJoin(users, eq(users.id, arenaProfiles.userId))
        .where(and(notBanned, gt(arenaProfiles.rating, mine.rating)));
      return { value: mine.rating, score: mine.rating, better: ahead?.n ?? 0 };
    }

    const spec = this.aggregate(metric);
    if (!spec) return null;
    const [mine] = await this.database.select({ total: spec.value.mapWith(Number) })
      .from(spec.table).where(and(spec.where, eq(spec.userCol, userId)));
    const total = mine?.total ?? 0;
    if (!(total > 0)) return null;

    const ahead = this.database.select({ userId: spec.userCol, total: spec.value.as("total") })
      .from(spec.table).innerJoin(users, eq(users.id, spec.userCol))
      .where(and(spec.where, notBanned))
      .groupBy(spec.userCol)
      .having(sql`${spec.value} > ${total}`)
      .as("ahead");
    const [count] = await this.database.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(ahead);
    return { value: total, score: total, better: count?.n ?? 0 };
  }

  async profiles(userIds: string[]): Promise<Map<string, RankingProfile>> {
    const result = new Map<string, RankingProfile>();
    if (userIds.length === 0) return result;
    const rows = await this.database.select({
      userId: userProfile.userId,
      name: userProfile.name,
      iconId: userProfile.iconId,
      level: userProfile.level,
      guildName: guilds.name,
    }).from(userProfile)
      .leftJoin(guildMembers, eq(guildMembers.userId, userProfile.userId))
      .leftJoin(guilds, eq(guilds.id, guildMembers.guildId))
      .where(inArray(userProfile.userId, userIds));
    for (const row of rows) {
      result.set(row.userId, { displayName: row.name, iconId: row.iconId, level: row.level, guildTag: row.guildName ?? null });
    }
    return result;
  }

  async topGuilds(weekKey: string, limit: number): Promise<GuildScoreRow[]> {
    const total = sql<number>`sum(${guildActivity.points})`;
    const ranked = await this.database.select({ guildId: guildActivity.guildId, total: total.mapWith(Number) })
      .from(guildActivity)
      .where(eq(guildActivity.weekKey, weekKey))
      .groupBy(guildActivity.guildId)
      .having(sql`${total} > 0`)
      .orderBy(desc(total), asc(guildActivity.guildId))
      .limit(limit);
    if (ranked.length === 0) return [];

    const details = await this.database.select({ id: guilds.id, name: guilds.name, iconId: guilds.iconId, memberCount: guilds.memberCount })
      .from(guilds).where(inArray(guilds.id, ranked.map((row) => row.guildId)));
    const byId = new Map(details.map((row) => [row.id, row]));
    const rows: GuildScoreRow[] = [];
    for (const entry of ranked) {
      const guild = byId.get(entry.guildId);
      if (guild) rows.push({ guildId: guild.id, name: guild.name, iconId: guild.iconId, memberCount: guild.memberCount, value: entry.total });
    }
    return rows;
  }

  async guildStanding(userId: string, weekKey: string): Promise<GuildStanding | null> {
    const [mine] = await this.database.select({ id: guilds.id, name: guilds.name, iconId: guilds.iconId, memberCount: guilds.memberCount })
      .from(guildMembers).innerJoin(guilds, eq(guilds.id, guildMembers.guildId))
      .where(eq(guildMembers.userId, userId)).limit(1);
    if (!mine) return null;

    const [points] = await this.database.select({ total: sql<number>`coalesce(sum(${guildActivity.points}), 0)`.mapWith(Number) })
      .from(guildActivity).where(and(eq(guildActivity.guildId, mine.id), eq(guildActivity.weekKey, weekKey)));
    const value = points?.total ?? 0;

    const total = sql<number>`sum(${guildActivity.points})`;
    const ahead = this.database.select({ guildId: guildActivity.guildId, total: total.as("total") })
      .from(guildActivity)
      .where(eq(guildActivity.weekKey, weekKey))
      .groupBy(guildActivity.guildId)
      .having(sql`${total} > ${value}`)
      .as("ahead");
    const [count] = await this.database.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(ahead);
    return {
      row: { guildId: mine.id, name: mine.name, iconId: mine.iconId, memberCount: mine.memberCount, value },
      better: count?.n ?? 0,
    };
  }

  /** Per-player sum / count of an aggregate metric (null when it has nothing to count). */
  private aggregate(metric: PlayerMetric): AggregateSpec | null {
    switch (metric.kind) {
      case "collection":
        return {
          table: userCharacters,
          userCol: userCharacters.userId,
          value: sql<number>`count(distinct ${userCharacters.characterId})`,
          where: undefined,
        };
      case "tower": {
        if (metric.seasons.length === 0) return null;
        return {
          table: userTowerProgress,
          userCol: userTowerProgress.userId,
          value: sql<number>`sum(${userTowerProgress.clearedFloors})`,
          where: or(...metric.seasons.map((season) => and(eq(userTowerProgress.regionId, season.regionId), eq(userTowerProgress.seasonKey, season.seasonKey)))),
        };
      }
      case "story": {
        if (metric.regionIds.length === 0) return null;
        const [easy, normal, hard, hell] = [0, 1, 2, 3].map((index) => Math.max(0, Math.floor(metric.weights[index] ?? 0)));
        return {
          table: userStageProgress,
          userCol: userStageProgress.userId,
          value: sql<number>`sum(case ${userStageProgress.difficulty} when 'Easy' then ${easy} when 'Normal' then ${normal} when 'Hard' then ${hard} when 'Hell' then ${hell} else 0 end)`,
          where: and(inArray(userStageProgress.regionId, metric.regionIds), gt(userStageProgress.clears, 0)),
        };
      }
      default:
        return null;
    }
  }
}
