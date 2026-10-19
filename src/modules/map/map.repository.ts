import { and, eq, gt, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { StageDifficulty } from "../../shared/kernel/types.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userMapPrefs, userStageProgress } from "../../infrastructure/database/schema/index.js";
import type { MapProgressRepository, StageClearOutcome, StageProgressRecord } from "./map.ports.js";

export class DrizzleMapProgressRepository extends DrizzleRepository implements MapProgressRepository {
  constructor(database: Database) {
    super(database);
  }

  async listProgress(userId: string, session?: DbSession): Promise<StageProgressRecord[]> {
    return this.db(session)
      .select({
        regionId: userStageProgress.regionId,
        stageId: userStageProgress.stageId,
        difficulty: userStageProgress.difficulty,
        clears: userStageProgress.clears,
        bestClearMs: userStageProgress.bestClearMs,
      })
      .from(userStageProgress)
      .where(and(eq(userStageProgress.userId, userId), gt(userStageProgress.clears, 0)));
  }

  async touchPrefs(userId: string, regionId: string, stageId: string, difficulty: StageDifficulty, session?: DbSession): Promise<void> {
    await this.db(session).insert(userMapPrefs)
      .values({ userId, lastRegionId: regionId, lastStageId: stageId, lastDifficulty: difficulty })
      .onDuplicateKeyUpdate({ set: { lastRegionId: regionId, lastStageId: stageId, lastDifficulty: difficulty } });
  }

  async recordClear(
    userId: string,
    regionId: string,
    stageId: string,
    difficulty: StageDifficulty,
    clearMs: number | null,
    session: DbSession,
  ): Promise<StageClearOutcome> {
    const db = this.db(session);
    const key = and(
      eq(userStageProgress.userId, userId),
      eq(userStageProgress.regionId, regionId),
      eq(userStageProgress.stageId, stageId),
      eq(userStageProgress.difficulty, difficulty),
    );

    const [existing] = await db.select({ clears: userStageProgress.clears, bestClearMs: userStageProgress.bestClearMs })
      .from(userStageProgress).where(key).limit(1).for("update");
    const normalizedMs = clearMs != null ? Math.max(0, Math.floor(clearMs)) : null;
    const now = new Date();

    if (!existing) {
      await db.insert(userStageProgress).values({
        userId, regionId, stageId, difficulty, firstClearAt: now, bestClearMs: normalizedMs, clears: 1, lastPlayedAt: now,
      });
    } else {
      const bestClearMs = normalizedMs == null ? existing.bestClearMs
        : existing.bestClearMs == null ? normalizedMs
        : Math.min(existing.bestClearMs, normalizedMs);
      await db.update(userStageProgress).set({
        clears: sql`${userStageProgress.clears} + 1`,
        bestClearMs,
        firstClearAt: sql`COALESCE(${userStageProgress.firstClearAt}, ${now})`,
        lastPlayedAt: now,
      }).where(key);
    }
    await this.touchPrefs(userId, regionId, stageId, difficulty, session);

    const [updated] = await db.select({ clears: userStageProgress.clears, bestClearMs: userStageProgress.bestClearMs })
      .from(userStageProgress).where(key).limit(1);

    return {
      firstClear: !existing || existing.clears === 0,
      clears: updated?.clears ?? 1,
      bestClearMs: updated?.bestClearMs ?? normalizedMs,
    };
  }
}
