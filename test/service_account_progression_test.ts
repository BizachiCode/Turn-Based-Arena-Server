import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { noAudit } from "../src/shared/kernel/audit";
import type { MapCatalog, MapStage } from "../src/config/MapCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { applyAccountExp, expToNextAccountLevel } from "../src/modules/progression/account-progression";
import { AccountProgressionService, type AccountExpConfig } from "../src/modules/progression/account-progression.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneService } from "../src/modules/rune/rune.service";
import { BattleRewardService } from "../src/modules/battle-pve/battle-rewards.service";
import {
  currencyRulesOf,
  InMemoryCharacterRepository,
  InMemoryMapProgressRepository,
  InMemoryProfileRepository,
  InMemoryPveBattleRepository,
  InMemoryUnitOfWork,
  InMemoryWalletRepository,
  SESSION,
} from "./support/fakes";

const USER = "user-1";

describe("Account EXP curve", () => {
  const curve = { maxLevel: 4, expPerLevel: [100, 200, 300] };

  it("levels up across several levels and keeps the remainder", () => {
    const result = applyAccountExp(curve, 1, 50, 300);
    assert.deepEqual(result, { level: 3, exp: 50, expGained: 300, levelsGained: 2, reachedLevels: [2, 3] });
  });

  it("discards EXP past the max level", () => {
    const result = applyAccountExp(curve, 3, 250, 1000);
    assert.equal(result.level, 4);
    assert.equal(result.exp, 0);
    assert.equal(result.expGained, 50);
    assert.equal(expToNextAccountLevel(curve, 4), 0);
    assert.equal(applyAccountExp(curve, 4, 0, 500).expGained, 0);
  });
});

describe("Account EXP from stage victories", () => {
  const stage: MapStage = {
    id: "s1",
    currencyId: "EN",
    costs: [],
    formation: { front: 2, back: 2, leaderIndex: 0 },
    rewards: [{
      difficulty: "Easy",
      currencies: [],
      firstClearCurrencies: [],
      unitExp: 0,
      accountExp: 0,
      randomDrops: [],
    }],
  };
  const boosted: MapStage = { ...stage, id: "s2", rewards: [{ ...stage.rewards![0], accountExp: 500 }] };
  const catalog: MapCatalog = { regions: [{ id: "r1", kind: "story", stageCount: 2, stages: [stage, boosted] }] };

  function setup(config: Partial<AccountExpConfig> = {}) {
    const wallets = new InMemoryWalletRepository();
    const characters = new InMemoryCharacterRepository();
    const battles = new InMemoryPveBattleRepository();
    const progress = new InMemoryMapProgressRepository();
    const profiles = new InMemoryProfileRepository();
    profiles.rows.set(USER, { name: "P", iconId: "", level: 1, currentExp: 0 });
    // Caps read the level the profile holds inside the transaction.
    wallets.getAccountLevel = async (userId: string) => profiles.rows.get(userId)?.level ?? 1;
    const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(battles).register(progress).register(profiles);
    const clock = new FixedClock(Date.UTC(2026, 9, 5));
    const currencies = currencyRulesOf([
      { id: "energy", hasCap: true, baseCap: 30, capScalesWithLevel: true, capIncrementsByLevel: [1] },
      { id: "gem" },
    ]);
    const ledger = new WalletLedger(wallets, currencies, clock);
    const account = new AccountProgressionService(profiles, ledger, currencies, () => ({
      maxLevel: 3,
      expPerLevel: [20, 50],
      expPerEnergy: 10,
      levelUpRewards: [{ level: 3, currencies: [{ currencyId: "gem", amount: 5 }] }],
      refillOnLevelUp: ["energy"],
      ...config,
    }));
    const progression = new MonsterProgression({
      starTiers: () => [{ stars: 1, maxLevel: 2, expPerLevel: [100] }],
      powerUp: () => ({ currencyId: "gem", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
      evolve: () => ({ currencyId: "gem", costPerStarUnit: 0, steps: [] }),
    });
    const rewards = new BattleRewardService(
      battles, progress, { catalog: () => catalog, getStage: (_r, s) => catalog.regions[0].stages.find((entry) => entry.id === s) },
      ledger, characters, progression, {} as RuneService, new RosterCache(noCache), new RuneCache(noCache),
      { int: () => 0, float: () => 0.99 }, uow, clock, noAudit, undefined, account,
    );
    return { wallets, battles, profiles, rewards };
  }

  async function startedBattle(battles: InMemoryPveBattleRepository, battleId: string, stageId = "s1", energySpent = 3) {
    await battles.createTicket({ id: `t-${battleId}`, userId: USER, regionId: "r1", stageId, difficulty: "Easy", currencyId: "energy", energySpent }, SESSION);
    return battles.consumeTicket(USER, { regionId: "r1", stageId, difficulty: "Easy" }, battleId, new Date(0), null, SESSION);
  }

  it("grants energy spent x expPerEnergy, refills energy and credits level rewards", async () => {
    const { wallets, battles, profiles, rewards } = setup();
    wallets.set(USER, "energy", 4);
    await startedBattle(battles, "B1", "s1", 3);

    const first = await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: [], clearMs: null });
    assert.ok(first.victory);
    assert.deepEqual(first.account, { expGained: 30, level: 2, currentExp: 10, expToNext: 50, levelsGained: 1, rewards: [{ currencyId: "energy", amount: 27 }] });
    assert.equal(wallets.amount(USER, "energy"), 31, "refilled to the level 2 cap");
    assert.equal(first.wallet.energy, 31);
    assert.deepEqual(profiles.rows.get(USER), { name: "P", iconId: "", level: 2, currentExp: 10 });
  });

  it("uses the stage override, credits level rewards and stops at the max level", async () => {
    const { wallets, battles, profiles, rewards } = setup();
    wallets.set(USER, "energy", 40);
    await startedBattle(battles, "B1", "s2", 3);

    const result = await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: [], clearMs: null });
    assert.ok(result.victory);
    assert.equal(result.account?.expGained, 70);
    assert.equal(result.account?.level, 3);
    assert.equal(result.account?.expToNext, 0);
    assert.deepEqual(result.account?.rewards, [{ currencyId: "gem", amount: 5 }], "energy above the cap is not refilled");
    assert.equal(wallets.amount(USER, "gem"), 5);
    assert.equal(profiles.rows.get(USER)?.level, 3);
  });

  it("grants nothing on defeat", async () => {
    const { battles, profiles, rewards } = setup();
    await startedBattle(battles, "B1");
    assert.deepEqual(await rewards.settle(USER, { battleId: "B1", victory: false, unitUids: [], clearMs: null }), { victory: false });
    assert.equal(profiles.rows.get(USER)?.currentExp, 0);
  });
});
