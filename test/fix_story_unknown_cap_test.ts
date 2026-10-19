import assert from "node:assert/strict";

import { StoryCatalogSchema } from "../src/config/StoryCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { noAudit } from "../src/shared/kernel/audit";
import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { StoryCompletionRecord, StoryRepository } from "../src/modules/story/story.ports";
import { MAX_UNKNOWN_DIALOGUE_COMPLETIONS, StoryService } from "../src/modules/story/story.service";
import { duplicateKeyError, InMemoryUnitOfWork } from "./support/fakes";
import { rewardKit } from "./support/reward-kit";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

class MemoryStory implements StoryRepository {
  completed = new Map<string, StoryCompletionRecord & { userId: string }>();
  snapshot(): unknown { return structuredClone(this.completed); }
  restore(state: unknown): void { this.completed = state as typeof this.completed; }
  async listCompleted(userId: string) {
    return [...this.completed.values()].filter((row) => row.userId === userId).map(({ userId: _u, ...row }) => ({ ...row }));
  }
  async findCompleted(userId: string, dialogueId: string) { return this.completed.get(`${userId}|${dialogueId}`) ?? null; }
  async insertCompleted(userId: string, dialogueId: string, skipped: boolean) {
    const key = `${userId}|${dialogueId}`;
    if (this.completed.has(key)) throw duplicateKeyError();
    this.completed.set(key, { userId, dialogueId, skipped, times: 1, completedAt: new Date(NOW) });
  }
  async incrementTimes() { /* unused */ }
  async findActive() { return null; }
  async saveActive() { /* unused */ }
  async clearActive() { /* unused */ }
  async accountLevel() { return 1; }
  async hasClearedStage() { return false; }
}

function setup() {
  const clock = new FixedClock(NOW);
  const repo = new MemoryStory();
  const { wallets, ledger, rewards } = rewardKit(clock);
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const catalog = StoryCatalogSchema.parse({ dialogues: [{ id: "known", rewards: {} }] });
  const service = new StoryService({
    story: repo, rewards, ledger, rosterCache: new RosterCache(noCache), runeCache: new RuneCache(noCache),
    audit: noAudit, uow, clock, catalog: () => catalog,
    lookup: (id) => catalog.dialogues.find((dialogue) => dialogue.id === id),
  });
  return { repo, service };
}

describe("Story: cap on completions of unknown dialogue ids", () => {
  it("accepts up to the cap, then rejects new unknown ids but keeps catalog ids and repeats working", async () => {
    const { service, repo } = setup();
    for (let i = 0; i < MAX_UNKNOWN_DIALOGUE_COMPLETIONS; i++) await service.complete("u1", `free_${i}`, false);
    assert.equal(repo.completed.size, MAX_UNKNOWN_DIALOGUE_COMPLETIONS);

    await assert.rejects(service.complete("u1", "free_over", false), isError("STORY_UNKNOWN_DIALOGUE"));
    assert.equal(repo.completed.size, MAX_UNKNOWN_DIALOGUE_COMPLETIONS, "no row inserted over the cap");

    const known = await service.complete("u1", "known", false);
    assert.equal(known.firstTime, true, "catalog ids are not limited");
    const repeat = await service.complete("u1", "free_0", false);
    assert.equal(repeat.firstTime, false, "an already completed unknown id is still accepted (idempotent)");
  });

  it("counts per account", async () => {
    const { service } = setup();
    for (let i = 0; i < MAX_UNKNOWN_DIALOGUE_COMPLETIONS; i++) await service.complete("u1", `free_${i}`, false);
    assert.equal((await service.complete("u2", "free_0", false)).firstTime, true);
  });
});
