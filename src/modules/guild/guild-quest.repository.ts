import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { guildActivity, guildChestClaims, guildQuestProgress, userProfile } from "../../infrastructure/database/schema/index.js";
import type { GuildContributorRow, GuildQuestProgressRow, GuildQuestRepository } from "./guild-quest.ports.js";

const progressColumns = {
  questId: guildQuestProgress.questId,
  progress: guildQuestProgress.progress,
  claimedAt: guildQuestProgress.claimedAt,
};

export class DrizzleGuildQuestRepository extends DrizzleRepository implements GuildQuestRepository {
  constructor(database: Database) {
    super(database);
  }

  async listProgress(userId: string, periodKey: string, session?: DbSession): Promise<GuildQuestProgressRow[]> {
    return this.db(session).select(progressColumns).from(guildQuestProgress)
      .where(and(eq(guildQuestProgress.userId, userId), eq(guildQuestProgress.periodKey, periodKey)));
  }

  async addProgress(userId: string, periodKey: string, quests: Array<{ questId: string; target: number }>, amount: number): Promise<void> {
    for (const quest of quests) {
      const initial = Math.min(quest.target, amount);
      await this.database.insert(guildQuestProgress)
        .values({ userId, questId: quest.questId, periodKey, progress: initial })
        .onDuplicateKeyUpdate({ set: { progress: sql`least(${quest.target}, ${guildQuestProgress.progress} + ${amount})` } });
    }
  }

  async lockProgress(userId: string, questId: string, periodKey: string, session: DbSession): Promise<GuildQuestProgressRow | null> {
    const [row] = await this.db(session).select(progressColumns).from(guildQuestProgress)
      .where(and(eq(guildQuestProgress.userId, userId), eq(guildQuestProgress.questId, questId), eq(guildQuestProgress.periodKey, periodKey)))
      .limit(1).for("update");
    return row ?? null;
  }

  async markQuestClaimed(userId: string, questId: string, periodKey: string, at: Date, session: DbSession): Promise<void> {
    await this.db(session).update(guildQuestProgress).set({ claimedAt: at })
      .where(and(eq(guildQuestProgress.userId, userId), eq(guildQuestProgress.questId, questId), eq(guildQuestProgress.periodKey, periodKey)));
  }

  async deleteProgressBefore(userId: string, beforePeriodKey: string): Promise<void> {
    await this.database.delete(guildQuestProgress)
      .where(and(eq(guildQuestProgress.userId, userId), lt(guildQuestProgress.periodKey, beforePeriodKey)));
  }

  async addActivity(guildId: string, weekKey: string, userId: string, points: number, session: DbSession): Promise<void> {
    if (!(points > 0)) return;
    await this.db(session).insert(guildActivity)
      .values({ guildId, weekKey, userId, points })
      .onDuplicateKeyUpdate({ set: { points: sql`${guildActivity.points} + ${points}` } });
  }

  async guildPoints(guildId: string, weekKey: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ total: sql<number>`coalesce(sum(${guildActivity.points}), 0)` })
      .from(guildActivity).where(and(eq(guildActivity.guildId, guildId), eq(guildActivity.weekKey, weekKey)));
    return Number(row?.total ?? 0);
  }

  async memberPoints(guildId: string, weekKey: string, userId: string): Promise<number> {
    const [row] = await this.database.select({ points: guildActivity.points }).from(guildActivity)
      .where(and(eq(guildActivity.guildId, guildId), eq(guildActivity.weekKey, weekKey), eq(guildActivity.userId, userId))).limit(1);
    return Number(row?.points ?? 0);
  }

  async contributors(guildId: string, weekKey: string, limit: number): Promise<GuildContributorRow[]> {
    const rows = await this.database.select({
      userId: guildActivity.userId,
      points: guildActivity.points,
      name: userProfile.name,
      level: userProfile.level,
      iconId: userProfile.iconId,
    }).from(guildActivity)
      .innerJoin(userProfile, eq(userProfile.userId, guildActivity.userId))
      .where(and(eq(guildActivity.guildId, guildId), eq(guildActivity.weekKey, weekKey)))
      .orderBy(desc(guildActivity.points), guildActivity.updatedAt)
      .limit(limit);
    return rows.map((row) => ({ ...row, points: Number(row.points) }));
  }

  async listChestClaims(userId: string, weekKey: string, session?: DbSession): Promise<Set<string>> {
    const rows = await this.db(session).select({ chestId: guildChestClaims.chestId }).from(guildChestClaims)
      .where(and(eq(guildChestClaims.userId, userId), eq(guildChestClaims.weekKey, weekKey)));
    return new Set(rows.map((row) => row.chestId));
  }

  async insertChestClaim(userId: string, weekKey: string, chestId: string, guildId: string, session: DbSession): Promise<void> {
    await this.db(session).insert(guildChestClaims).values({ userId, weekKey, chestId, guildId });
  }
}
