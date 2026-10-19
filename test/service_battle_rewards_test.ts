import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { noAudit } from "../src/shared/kernel/audit";
import { createSeededRandom, type RandomSource } from "../src/shared/kernel/random";
import type { MapCatalog, MapStage } from "../src/config/MapCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneService } from "../src/modules/rune/rune.service";
import { BattleRewardService } from "../src/modules/battle-pve/battle-rewards.service";
import { evaluateStageUnlock } from "../src/modules/map/map.unlock";
import {
  currencyRulesOf,
  InMemoryCharacterRepository,
  InMemoryMapProgressRepository,
  InMemoryPveBattleRepository,
  InMemoryUnitOfWork,
  InMemoryWalletRepository,
  SESSION,
} from "./support/fakes";

const USER = "user-1";

const stage: MapStage = {
  id: "s1",
  currencyId: "EN",
  costs: [],
  formation: { front: 2, back: 2, leaderIndex: 0 },
  rewards: [{
    difficulty: "Easy",
    currencies: [{ currencyId: "gold", amount: 300 }],
    firstClearCurrencies: [{ currencyId: "gem", amount: 10 }],
    unitExp: 150,
    accountExp: 0,
    dropTable: { id: "t", rune: { chance: 1, stars: [{ stars: 2, weight: 1 }], grades: [{ grade: 3, weight: 1 }], sets: [] }, items: [] },
    randomDrops: [],
  }],
};
const catalog: MapCatalog = { regions: [{ id: "r1", kind: "story", stageCount: 2, stages: [stage, { ...stage, id: "s2", rewards: undefined }] }] };

function setup(random: RandomSource = createSeededRandom(1)) {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  const battles = new InMemoryPveBattleRepository();
  const progress = new InMemoryMapProgressRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(battles).register(progress);
  const clock = new FixedClock(Date.UTC(2026, 9, 5));
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "gold" }, { id: "gem" }]), clock);
  const progression = new MonsterProgression({
    starTiers: () => [{ stars: 2, maxLevel: 5, expPerLevel: [100, 100, 100, 100] }],
    powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
  });
  const grantedRunes: unknown[] = [];
  const runes = {
    grantRunes: async (_session: unknown, _userId: string, specs: Array<{ tier: number; quality?: number }>) => {
      const created = specs.map((spec, index) => ({ uid: `rune-${grantedRunes.length + index}`, tier: spec.tier, quality: spec.quality }));
      grantedRunes.push(...created);
      return created;
    },
  } as unknown as RuneService;

  const rewards = new BattleRewardService(
    battles, progress, { catalog: () => catalog, getStage: (_r, s) => catalog.regions[0].stages.find((entry) => entry.id === s) },
    ledger, characters, progression, runes, new RosterCache(noCache), new RuneCache(noCache), random, uow, clock, noAudit,
  );
  return { wallets, characters, battles, progress, rewards, grantedRunes };
}

async function startedBattle(battles: InMemoryPveBattleRepository, battleId: string, stageId = "s1") {
  await battles.createTicket({ id: `t-${battleId}`, userId: USER, regionId: "r1", stageId, difficulty: "Easy", currencyId: "energy", energySpent: 3 }, SESSION);
  return battles.consumeTicket(USER, { regionId: "r1", stageId, difficulty: "Easy" }, battleId, new Date(0), null, SESSION);
}

describe("BattleRewardService", () => {
  it("grants currencies, first-clear bonus, unit EXP and the rune drop once", async () => {
    const { wallets, characters, battles, rewards, grantedRunes } = setup();
    characters.add(USER, { uid: "U1", characterId: "c1", stars: 2, level: 1, currentExp: 60 });
    characters.add(USER, { uid: "U2", characterId: "c1", stars: 2, level: 5 });
    await startedBattle(battles, "B1");

    const result = await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: ["U1", "U2"], clearMs: 1234 });
    assert.equal(result.victory, true);
    if (!result.victory) return;
    assert.equal(result.firstClear, true);
    assert.deepEqual(result.currencies, [{ currencyId: "gold", amount: 300 }, { currencyId: "gem", amount: 10 }]);
    assert.deepEqual(result.units.map((unit) => [unit.uid, unit.expGained, unit.level, unit.currentExp, unit.leveledUp]), [
      ["U1", 150, 3, 10, true],
      ["U2", 0, 5, 0, false],
    ]);
    assert.deepEqual(result.runes.map((rune) => [rune.tier, rune.quality]), [[2, 3]], "rune stars and grade from the drop table");
    assert.deepEqual(result.wallet, { gold: 300, gem: 10 });

    const again = await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: ["U1"], clearMs: 1 });
    assert.deepEqual(again, JSON.parse(JSON.stringify(result)), "idempotent per battle");
    assert.equal(wallets.amount(USER, "gold"), 300);
    assert.equal(grantedRunes.length, 1);
  });

  it("only grants the first-clear bonus once and nothing on defeat", async () => {
    const { wallets, battles, rewards } = setup({ int: () => 0, float: () => 0.99 });
    await startedBattle(battles, "B1");
    await startedBattle(battles, "B2");
    await startedBattle(battles, "B3");

    await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: [], clearMs: null });
    const second = await rewards.settle(USER, { battleId: "B2", victory: true, unitUids: [], clearMs: null });
    assert.equal(second.victory && second.firstClear, false);
    assert.deepEqual(await rewards.settle(USER, { battleId: "B3", victory: false, unitUids: [], clearMs: null }), { victory: false });
    assert.equal(wallets.amount(USER, "gold"), 600);
    assert.equal(wallets.amount(USER, "gem"), 10);
  });

  it("rejects unknown battles and battles of other players", async () => {
    const { battles, rewards } = setup();
    await startedBattle(battles, "B1");
    await assert.rejects(rewards.settle("intruder", { battleId: "B1", victory: true, unitUids: [], clearMs: null }));
  });
});

describe("Stage unlock rules", () => {
  it("requires the previous stage and difficulty", () => {
    assert.equal(evaluateStageUnlock(catalog, [], "r1", "s1", "Easy"), null);
    assert.equal(evaluateStageUnlock(catalog, [], "r1", "s2", "Easy")?.code, "STAGE_LOCKED");
    const cleared = [{ regionId: "r1", stageId: "s1", difficulty: "Easy" as const, clears: 1, bestClearMs: null }];
    assert.equal(evaluateStageUnlock(catalog, cleared, "r1", "s2", "Easy"), null);
    assert.equal(evaluateStageUnlock(catalog, cleared, "r1", "s1", "Normal")?.code, "DIFFICULTY_LOCKED");
  });
});
