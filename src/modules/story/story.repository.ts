import { and, eq, gt, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userProfile, userStageProgress, userStoryActive, userStoryProgress } from "../../infrastructure/database/schema/index.js";
import type { StoryActiveRecord, StoryCompletionRecord, StoryRepository } from "./story.ports.js";

const completionColumns = {
  dialogueId: userStoryProgress.dialogueId,
  skipped: userStoryProgress.skipped,
  times: userStoryProgress.times,
  completedAt: userStoryProgress.completedAt,
};

const toCompletion = (row: { dialogueId: string; skipped: number; times: number; completedAt: Date }): StoryCompletionRecord =>
  ({ ...row, skipped: row.skipped === 1 });

export class DrizzleStoryRepository extends DrizzleRepository implements StoryRepository {
  constructor(database: Database) {
    super(database);
  }

  async listCompleted(userId: string, session?: DbSession): Promise<StoryCompletionRecord[]> {
    const rows = await this.db(session).select(completionColumns).from(userStoryProgress)
      .where(eq(userStoryProgress.userId, userId));
    return rows.map(toCompletion);
  }

  async findCompleted(userId: string, dialogueId: string, session: DbSession): Promise<StoryCompletionRecord | null> {
    const [row] = await this.db(session).select(completionColumns).from(userStoryProgress)
      .where(and(eq(userStoryProgress.userId, userId), eq(userStoryProgress.dialogueId, dialogueId)))
      .limit(1).for("update");
    return row ? toCompletion(row) : null;
  }

  async insertCompleted(userId: string, dialogueId: string, skipped: boolean, session: DbSession): Promise<void> {
    await this.db(session).insert(userStoryProgress).values({ userId, dialogueId, skipped: skipped ? 1 : 0 });
  }

  async incrementTimes(userId: string, dialogueId: string, session: DbSession): Promise<void> {
    await this.db(session).update(userStoryProgress).set({ times: sql`${userStoryProgress.times} + 1` })
      .where(and(eq(userStoryProgress.userId, userId), eq(userStoryProgress.dialogueId, dialogueId)));
  }

  async findActive(userId: string, session?: DbSession): Promise<StoryActiveRecord | null> {
    const [row] = await this.db(session).select({ dialogueId: userStoryActive.dialogueId, step: userStoryActive.step })
      .from(userStoryActive).where(eq(userStoryActive.userId, userId)).limit(1);
    return row ?? null;
  }

  async saveActive(userId: string, dialogueId: string, step: number, session?: DbSession): Promise<void> {
    await this.db(session).insert(userStoryActive).values({ userId, dialogueId, step })
      .onDuplicateKeyUpdate({ set: { dialogueId, step } });
  }

  async clearActive(userId: string, dialogueId: string | null, session?: DbSession): Promise<void> {
    const where = dialogueId
      ? and(eq(userStoryActive.userId, userId), eq(userStoryActive.dialogueId, dialogueId))
      : eq(userStoryActive.userId, userId);
    await this.db(session).delete(userStoryActive).where(where);
  }

  async accountLevel(userId: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ level: userProfile.level }).from(userProfile)
      .where(eq(userProfile.userId, userId)).limit(1);
    return row?.level ?? 1;
  }

  async hasClearedStage(userId: string, stageId: string, session?: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ clears: userStageProgress.clears }).from(userStageProgress)
      .where(and(eq(userStageProgress.userId, userId), eq(userStageProgress.stageId, stageId), gt(userStageProgress.clears, 0)))
      .limit(1);
    return !!row;
  }
}
