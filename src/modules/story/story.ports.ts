import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** A completed dialogue sequence. */
export type StoryCompletionRecord = { dialogueId: string; skipped: boolean; times: number; completedAt: Date };

/** The sequence in progress. */
export type StoryActiveRecord = { dialogueId: string; step: number };

/** Persistence port of the story/tutorial progress (scoped by the authenticated user). */
export interface StoryRepository {
  listCompleted(userId: string, session?: DbSession): Promise<StoryCompletionRecord[]>;
  /** Locked read of one completion. */
  findCompleted(userId: string, dialogueId: string, session: DbSession): Promise<StoryCompletionRecord | null>;
  /** Inserts the first completion; throws a duplicate-key error when it exists. */
  insertCompleted(userId: string, dialogueId: string, skipped: boolean, session: DbSession): Promise<void>;
  incrementTimes(userId: string, dialogueId: string, session: DbSession): Promise<void>;

  findActive(userId: string, session?: DbSession): Promise<StoryActiveRecord | null>;
  saveActive(userId: string, dialogueId: string, step: number, session?: DbSession): Promise<void>;
  clearActive(userId: string, dialogueId: string | null, session?: DbSession): Promise<void>;

  accountLevel(userId: string, session?: DbSession): Promise<number>;
  /** True when the stage was won at least once (any difficulty). */
  hasClearedStage(userId: string, stageId: string, session?: DbSession): Promise<boolean>;
}
