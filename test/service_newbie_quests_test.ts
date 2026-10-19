import assert from "node:assert/strict";

import { NewbieQuestBookSchema, parseNewbieQuestBook, type NewbieQuestBook } from "../src/config/NewPlayerQuestCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { PlayerActivityHub } from "../src/shared/kernel/activity";
import { noAudit } from "../src/shared/kernel/audit";
import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import type { StageProgressRecord } from "../src/modules/map/map.ports";
import { counterId, NEWBIE_PERIOD, NewbieQuestService } from "../src/modules/missions/newbie-quests.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import { InMemoryUnitOfWork } from "./support/fakes";
import { InMemoryMissionRepository } from "./support/mission-fakes";
import { rewardKit } from "./support/reward-kit";

const USER = "user-1";
const NOW = Date.UTC(2026, 9, 15, 10);
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
const pay = (currencyId: string, amount: number) => ({ currencies: [{ currencyId, amount }], characters: [], constructions: [], scrolls: [], runes: [] });

const BOOK = {
  chapters: [
    {
      id: "ch1",
      quests: [
        { id: "q_summon", kind: "summon", target: 3, rewards: pay("GO", 1000) },
        { id: "q_level", kind: "account_level", target: 5, rewards: pay("DM", 50) },
        { id: "q_stage", kind: "clear_stage", regionId: "r1", stageId: "s5", difficulty: "Normal", rewards: pay("EN", 10) },
      ],
      rewards: pay("DM", 100),
    },
    {
      id: "ch2",
      quests: [
        { id: "q_mons", kind: "own_monsters", target: 2, stars: 4, rewards: pay("GO", 5000) },
        { id: "q_runes", kind: "rune_level", target: 1, runeLevel: 6, rewards: pay("GO", 3000) },
        { id: "q_equip", kind: "equip_runes", target: 6, rewards: pay("mystic_scroll_cur", 1) },
      ],
    },
  ],
};

function setup(book: NewbieQuestBook = parseNewbieQuestBook(JSON.stringify(BOOK))) {
  const clock = new FixedClock(NOW);
  const repo = new InMemoryMissionRepository();
  const { wallets, ledger, rewards } = rewardKit(clock);
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const player = { level: 1, clears: [] as StageProgressRecord[], monsters: [] as number[], runes: [] as number[], equipped: 0 };
  const service = new NewbieQuestService({
    missions: repo,
    facts: {
      accountLevel: async () => player.level,
      stageClears: async () => player.clears,
      countMonsters: async (_user, minStars) => player.monsters.filter((stars) => stars >= minStars).length,
      countRunes: async (_user, minLevel) => player.runes.filter((level) => level >= minLevel).length,
      countEquippedRunes: async () => player.equipped,
    },
    rewards,
    ledger,
    rosterCache: new RosterCache(noCache),
    runeCache: new RuneCache(noCache),
    audit: noAudit,
    uow,
    clock,
    config: () => book,
  });
  const hub = new PlayerActivityHub();
  hub.subscribe(service);
  return { service, hub, repo, wallets, player };
}

describe("New-player quests", () => {
  it("parses the Unity export (ordinals, PascalCase) and rejects broken books", () => {
    const book = parseNewbieQuestBook(JSON.stringify({
      Enabled: true,
      Chapters: [{ Id: "c", Quests: [{ Id: "q", Kind: 1, RegionId: "r1", StageId: "s1", Difficulty: 2, Target: 9 }] }],
    }));
    assert.deepEqual([book.chapters[0].quests[0].kind, book.chapters[0].quests[0].difficulty], ["clear_stage", "Hard"]);
    assert.throws(() => parseNewbieQuestBook(JSON.stringify({ chapters: [BOOK.chapters[0], { ...BOOK.chapters[1], quests: [BOOK.chapters[0].quests[0]] }] })), /duplicate quest/);
    assert.throws(() => parseNewbieQuestBook(JSON.stringify({ chapters: [{ id: "c", quests: [{ id: "q", kind: "clear_stage" }] }] })), /regionId/);
    assert.equal(NewbieQuestBookSchema.parse({}).chapters.length > 0, true, "sample book without a file");
  });

  it("counts activity once per kind and reads state kinds live", async () => {
    const { service, hub, repo, player } = setup();
    await hub.record(USER, "summon", 2);
    await hub.record(USER, "arena_battle", 4); // not used by the book: no row
    await hub.record(USER, "account_level", 9); // state kind: read from the profile, never counted
    assert.deepEqual([...repo.rows.values()].map((row) => [row.missionId, row.periodKey, row.progress]), [[counterId("summon"), NEWBIE_PERIOD, 2]]);

    player.level = 6;
    player.clears = [{ regionId: "r1", stageId: "s5", difficulty: "Hard", clears: 1, bestClearMs: null }];
    const state = await service.getState(USER);
    const [ch1, ch2] = state.chapters;
    assert.deepEqual(ch1.quests.map((quest) => [quest.questId, quest.progress, quest.target, quest.claimable]), [
      ["q_summon", 2, 3, false],
      ["q_level", 5, 5, true],
      ["q_stage", 1, 1, true], // cleared on Hard counts for Normal
    ]);
    assert.equal(ch2.unlocked, false);
    assert.deepEqual([state.claimable, state.currentChapter, state.completed], [2, 0, false]);
  });

  it("claims quests once, unlocks the next chapter and grants the chapter reward", async () => {
    const { service, hub, wallets, player } = setup();
    player.level = 5;
    player.clears = [{ regionId: "r1", stageId: "s5", difficulty: "Normal", clears: 1, bestClearMs: null }];
    player.monsters = [4, 5, 3];
    player.runes = [6];
    player.equipped = 6;

    await assert.rejects(service.claim(USER, "q_summon"), isError("NEWBIE_QUEST_NOT_COMPLETE"));
    await assert.rejects(service.claim(USER, "q_mons"), isError("NEWBIE_QUEST_LOCKED"), "chapter 2 is locked");
    await assert.rejects(service.claim(USER, "nope"), isError("NEWBIE_QUEST_NOT_FOUND"));
    await assert.rejects(service.claimChapter(USER, "ch1"), isError("NEWBIE_QUEST_NOT_COMPLETE"));

    const claimed = await service.claim(USER, "q_level");
    assert.deepEqual(claimed.grants.currencies, [{ currencyId: "DM", amount: 50 }]);
    await assert.rejects(service.claim(USER, "q_level"), isError("NEWBIE_QUEST_CLAIMED"));
    await service.claim(USER, "q_stage");
    await hub.record(USER, "summon", 5);
    await service.claim(USER, "q_summon");

    const chapter = await service.claimChapter(USER, "ch1");
    assert.deepEqual(chapter.grants.currencies, [{ currencyId: "DM", amount: 100 }]);
    await assert.rejects(service.claimChapter(USER, "ch1"), isError("NEWBIE_QUEST_CLAIMED"));
    await assert.rejects(service.claimChapter(USER, "ch2"), isError("NEWBIE_QUEST_NOT_FOUND"), "chapter 2 has no reward");
    assert.equal(chapter.chapters[1].unlocked, true);
    assert.equal(chapter.currentChapter, 1);

    for (const questId of ["q_mons", "q_runes", "q_equip"]) await service.claim(USER, questId);
    const done = await service.getState(USER);
    assert.deepEqual([done.completed, done.claimable], [true, 0]);
    assert.equal(wallets.amount(USER, "DM"), 150);
    assert.equal(wallets.amount(USER, "GO"), 9000);
    assert.equal(wallets.amount(USER, "mystic_scroll_cur"), 1);
  });

  it("refuses everything while the book is disabled", async () => {
    const { service } = setup({ ...parseNewbieQuestBook(JSON.stringify(BOOK)), enabled: false });
    await assert.rejects(service.getState(USER), isError("NEWBIE_QUESTS_DISABLED"));
    await assert.rejects(service.claim(USER, "q_level"), isError("NEWBIE_QUESTS_DISABLED"));
  });
});
