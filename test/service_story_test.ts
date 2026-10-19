import assert from "node:assert/strict";

import { StoryCatalogSchema, type StoryCatalog } from "../src/config/StoryCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { noAudit } from "../src/shared/kernel/audit";
import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { StoryActiveRecord, StoryCompletionRecord, StoryRepository } from "../src/modules/story/story.ports";
import { StoryService } from "../src/modules/story/story.service";
import { duplicateKeyError, InMemoryUnitOfWork } from "./support/fakes";
import { rewardKit } from "./support/reward-kit";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

class InMemoryStoryRepository implements StoryRepository {
  completed = new Map<string, StoryCompletionRecord & { userId: string }>();
  active = new Map<string, StoryActiveRecord>();
  levels = new Map<string, number>();
  clears = new Set<string>();

  snapshot(): unknown { return { completed: structuredClone(this.completed), active: structuredClone(this.active) }; }
  restore(state: unknown): void { Object.assign(this, state as object); }

  async listCompleted(userId: string) {
    return [...this.completed.values()].filter((row) => row.userId === userId).map(({ userId: _u, ...row }) => ({ ...row }));
  }
  async findCompleted(userId: string, dialogueId: string) {
    const row = this.completed.get(`${userId}|${dialogueId}`);
    return row ? { dialogueId: row.dialogueId, skipped: row.skipped, times: row.times, completedAt: row.completedAt } : null;
  }
  async insertCompleted(userId: string, dialogueId: string, skipped: boolean) {
    const key = `${userId}|${dialogueId}`;
    if (this.completed.has(key)) throw duplicateKeyError();
    this.completed.set(key, { userId, dialogueId, skipped, times: 1, completedAt: new Date(NOW) });
  }
  async incrementTimes(userId: string, dialogueId: string) { this.completed.get(`${userId}|${dialogueId}`)!.times++; }
  async findActive(userId: string) { const row = this.active.get(userId); return row ? { ...row } : null; }
  async saveActive(userId: string, dialogueId: string, step: number) { this.active.set(userId, { dialogueId, step }); }
  async clearActive(userId: string, dialogueId: string | null) {
    const row = this.active.get(userId);
    if (row && (!dialogueId || row.dialogueId === dialogueId)) this.active.delete(userId);
  }
  async accountLevel(userId: string) { return this.levels.get(userId) ?? 1; }
  async hasClearedStage(userId: string, stageId: string) { return this.clears.has(`${userId}|${stageId}`); }
}

function setup(overrides: Partial<StoryCatalog> = {}) {
  const clock = new FixedClock(NOW);
  const repo = new InMemoryStoryRepository();
  const { wallets, ledger, rewards } = rewardKit(clock);
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const catalog = StoryCatalogSchema.parse({
    dialogues: [
      { id: "tutorial_welcome", rewards: { currencies: [{ currencyId: "DM", amount: 100 }] } },
      { id: "tutorial_summon", prerequisites: ["tutorial_welcome"], rewards: { currencies: [{ currencyId: "mystic_scroll_cur", amount: 1 }] } },
      { id: "story_level5", minAccountLevel: 5, rewardWhenSkipped: false, rewards: { currencies: [{ currencyId: "GO", amount: 500 }] } },
      { id: "npc_chat", repeatable: true, rewards: { currencies: [{ currencyId: "GO", amount: 10 }] } },
      { id: "story_boss_outro", requiredStageClear: "region_1_stage_10", rewards: { currencies: [{ currencyId: "DM", amount: 50 }] } },
    ],
    ...overrides,
  });
  const service = new StoryService({
    story: repo, rewards, ledger, rosterCache: new RosterCache(noCache), runeCache: new RuneCache(noCache),
    audit: noAudit, uow, clock,
    catalog: () => catalog,
    lookup: (id) => catalog.dialogues.find((dialogue) => dialogue.id === id),
  });
  return { repo, wallets, service };
}

describe("Story service", () => {
  it("grants the rewards of the first completion only", async () => {
    const { service, wallets } = setup();
    await service.saveProgress("u1", "tutorial_welcome", 3);
    assert.deepEqual((await service.getState("u1")).active, { dialogueId: "tutorial_welcome", step: 3 });

    const first = await service.complete("u1", "tutorial_welcome", false);
    assert.equal(first.firstTime, true);
    assert.deepEqual(first.grants.currencies, [{ currencyId: "DM", amount: 100 }]);
    assert.equal(first.active, null, "completing clears the sequence in progress");
    assert.deepEqual(first.completed.map((row) => row.dialogueId), ["tutorial_welcome"]);

    const again = await service.complete("u1", "tutorial_welcome", false);
    assert.equal(again.firstTime, false);
    assert.deepEqual(again.grants.currencies, []);
    assert.equal(again.wallet, null);
    assert.equal(wallets.amount("u1", "DM"), 100);
  });

  it("enforces prerequisites and the account level", async () => {
    const { service, repo } = setup();
    await assert.rejects(service.complete("u1", "tutorial_summon", false), isError("STORY_LOCKED"));
    await service.complete("u1", "tutorial_welcome", true);
    const summon = await service.complete("u1", "tutorial_summon", false);
    assert.deepEqual(summon.grants.currencies, [{ currencyId: "mystic_scroll_cur", amount: 1 }]);

    await assert.rejects(service.complete("u1", "story_level5", false), isError("STORY_LOCKED"));
    repo.levels.set("u1", 5);
    assert.equal((await service.complete("u1", "story_level5", false)).firstTime, true);
  });

  it("story beats after a victory need that stage cleared", async () => {
    const { service, repo, wallets } = setup();
    await assert.rejects(service.complete("u1", "story_boss_outro", false), isError("STORY_LOCKED"));
    repo.clears.add("u1|region_1_stage_10");
    assert.equal((await service.complete("u1", "story_boss_outro", false)).firstTime, true);
    assert.equal(wallets.amount("u1", "DM"), 50);
  });

  it("skipping completes without rewards when rewardWhenSkipped is false, and counts repeatable sequences", async () => {
    const { service, repo, wallets } = setup();
    repo.levels.set("u1", 9);
    const skipped = await service.complete("u1", "story_level5", true);
    assert.equal(skipped.firstTime, true);
    assert.deepEqual(skipped.grants.currencies, []);
    assert.equal(skipped.completed[0].skipped, true);

    await service.complete("u1", "npc_chat", false);
    await service.complete("u1", "npc_chat", false);
    assert.equal(wallets.amount("u1", "GO"), 10, "repeatable rewards are granted once");
    assert.equal((await service.getState("u1")).completed.find((row) => row.dialogueId === "npc_chat")?.times, 2);
  });

  it("accepts unknown dialogues without rewards unless the catalog forbids them", async () => {
    const open = setup();
    const result = await open.service.complete("u1", "free_story", false);
    assert.equal(result.firstTime, true);
    assert.deepEqual(result.grants.currencies, []);

    const strict = setup({ allowUnknownDialogues: false });
    await assert.rejects(strict.service.complete("u1", "free_story", false), isError("STORY_UNKNOWN_DIALOGUE"));
    await assert.rejects(strict.service.saveProgress("u1", "free_story", 0), isError("STORY_UNKNOWN_DIALOGUE"));
  });
});
