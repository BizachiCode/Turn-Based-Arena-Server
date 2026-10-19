// Story/tutorial progress: which dialogue sequences the player completed (or skipped), the one in progress (so the
// client resumes it after a restart) and the rewards of `dialogues.json`, granted once on the first completion.
//
// The client decides when a sequence plays (its triggers); the server only accepts completions whose prerequisites,
// account level and required stage clear (story beats after a victory) are met, so rewards cannot be collected out of
// order or twice.

import type { StoryCatalog, StoryDialogue } from "../../config/StoryCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import { emptyGrants, hasRewards, type RewardGranter } from "../rewards/reward-granter.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";
import type { StoryCompleteDto, StoryStateDto } from "./story.dto.js";
import type { StoryCompletionRecord, StoryRepository } from "./story.ports.js";

export type StoryServiceDeps = {
  story: StoryRepository;
  rewards: RewardGranter;
  ledger: WalletLedger;
  rosterCache: RosterCache;
  runeCache: RuneCache;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
  catalog: () => StoryCatalog;
  lookup: (dialogueId: string) => StoryDialogue | undefined;
};

/**
 * Completions of ids that are not in the catalog (`allowUnknownDialogues`) a single account may keep. Catalog ids are
 * unlimited; this only bounds `user_story_progress` (and the state payload) against id spamming.
 */
export const MAX_UNKNOWN_DIALOGUE_COMPLETIONS = 200;

export class StoryService {
  constructor(private readonly deps: StoryServiceDeps) {}

  async getState(userId: string): Promise<StoryStateDto> {
    const completed = await this.deps.story.listCompleted(userId);
    const active = await this.deps.story.findActive(userId);
    return {
      ok: true,
      serverTime: this.deps.clock.now().toISOString(),
      completed: completed.map((row) => this.toDto(row)),
      active: active ? { dialogueId: active.dialogueId, step: active.step } : null,
    };
  }

  /** Remembers the sequence in progress and its step (the client resumes it after a restart). */
  async saveProgress(userId: string, dialogueId: string, step: number): Promise<StoryStateDto> {
    this.resolve(dialogueId);
    await this.deps.story.saveActive(userId, dialogueId, Math.max(0, Math.floor(step)));
    return this.getState(userId);
  }

  /** Forgets the sequence in progress (abandoned without completing). */
  async clearProgress(userId: string): Promise<StoryStateDto> {
    await this.deps.story.clearActive(userId, null);
    return this.getState(userId);
  }

  /**
   * Completes a sequence. The first completion grants its rewards (unless skipped and `rewardWhenSkipped` is false);
   * completing it again is accepted (idempotent) without rewards, and counted for repeatable sequences.
   */
  async complete(userId: string, dialogueId: string, skipped: boolean): Promise<StoryCompleteDto> {
    const dialogue = this.resolve(dialogueId);
    const outcome = await this.deps.uow.transaction(async (session) => {
      const existing = await this.deps.story.findCompleted(userId, dialogueId, session);
      if (existing) {
        if (dialogue?.repeatable) await this.deps.story.incrementTimes(userId, dialogueId, session);
        await this.deps.story.clearActive(userId, dialogueId, session);
        return { firstTime: false, grants: null as ShopGrantsDto | null };
      }

      const completedRows = await this.deps.story.listCompleted(userId, session);
      if (!dialogue) {
        const unknownCompleted = completedRows.filter((row) => !this.deps.lookup(row.dialogueId)).length;
        if (unknownCompleted >= MAX_UNKNOWN_DIALOGUE_COMPLETIONS) throw new AppError(ErrorCode.STORY_UNKNOWN_DIALOGUE);
      }

      if (dialogue) {
        const done = new Set(completedRows.map((row) => row.dialogueId));
        const missing = dialogue.prerequisites.filter((id) => !done.has(id));
        if (missing.length > 0) throw new AppError(ErrorCode.STORY_LOCKED, { fields: { requires: missing } });
        const level = await this.deps.story.accountLevel(userId, session);
        if (level < dialogue.minAccountLevel) throw new AppError(ErrorCode.STORY_LOCKED, { fields: { requiredLevel: dialogue.minAccountLevel } });
        if (dialogue.requiredStageClear && !(await this.deps.story.hasClearedStage(userId, dialogue.requiredStageClear, session)))
          throw new AppError(ErrorCode.STORY_LOCKED, { fields: { requiredStage: dialogue.requiredStageClear } });
      }

      try {
        await this.deps.story.insertCompleted(userId, dialogueId, skipped, session);
      } catch (error) {
        // Completed concurrently by another request: nothing more to grant.
        if (isDuplicateKeyError(error)) return { firstTime: false, grants: null };
        throw error;
      }
      await this.deps.story.clearActive(userId, dialogueId, session);

      const rewarded = dialogue && hasRewards(dialogue.rewards) && (!skipped || dialogue.rewardWhenSkipped);
      const grants = rewarded ? await this.deps.rewards.grant(session, userId, dialogue.rewards, { runeOrigin: "story" }) : null;
      await this.deps.audit.record({ userId, kind: "STORY_COMPLETE", meta: { dialogueId, skipped, rewarded: !!grants } }, session);
      return { firstTime: true, grants };
    });

    if (outcome.grants?.characters.length) await this.deps.rosterCache.invalidate(userId);
    if (outcome.grants?.runes.length) await this.deps.runeCache.invalidate(userId);
    return {
      ...(await this.getState(userId)),
      dialogueId,
      firstTime: outcome.firstTime,
      grants: outcome.grants ?? emptyGrants(),
      wallet: outcome.grants ? await this.deps.ledger.snapshot(userId) : null,
    };
  }

  /** Catalog entry of a sequence (undefined for unknown ids when they are allowed). */
  private resolve(dialogueId: string): StoryDialogue | undefined {
    const dialogue = this.deps.lookup(dialogueId);
    if (!dialogue && !this.deps.catalog().allowUnknownDialogues) throw new AppError(ErrorCode.STORY_UNKNOWN_DIALOGUE);
    return dialogue;
  }

  private toDto(row: StoryCompletionRecord) {
    return { dialogueId: row.dialogueId, skipped: row.skipped, times: row.times, completedAt: row.completedAt.toISOString() };
  }
}
