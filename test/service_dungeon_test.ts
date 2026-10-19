import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { noAudit } from "../src/shared/kernel/audit";
import type { RandomSource } from "../src/shared/kernel/random";
import { gameWeekday } from "../src/shared/kernel/daily-reset";
import type { MapCatalog, MapStage } from "../src/config/MapCatalog";
import { DungeonConfigSchema, parseDungeonConfig, type DungeonConfig } from "../src/config/DungeonCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { EconomyService } from "../src/modules/economy/economy.service";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneService } from "../src/modules/rune/rune.service";
import { BattleRewardService } from "../src/modules/battle-pve/battle-rewards.service";
import { evaluateStageUnlock } from "../src/modules/map/map.unlock";
import { MapService } from "../src/modules/map/map.service";
import { DungeonService } from "../src/modules/dungeon/dungeon.service";
import { evaluateDungeonGate, isHallOpen } from "../src/modules/dungeon/dungeon.domain";
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

const floor = (id: string, extra: Partial<MapStage> = {}): MapStage => ({
  id,
  scene: "Dungeon_Test",
  currencyId: "energy",
  costs: [{ difficulty: "Easy", amount: 3 }, { difficulty: "Normal", amount: 3 }, { difficulty: "Hard", amount: 3 }, { difficulty: "Hell", amount: 3 }],
  formation: { front: 2, back: 2, leaderIndex: 0 },
  ...extra,
});

const catalog: MapCatalog = {
  regions: [
    { id: "r1", kind: "story", stageCount: 1, stages: [floor("s1")] },
    { id: "hall_fire", kind: "dungeon", stageCount: 2, stages: [floor("b1"), floor("b2")] },
    { id: "r2", kind: "story", stageCount: 1, stages: [floor("s1")] },
  ],
};

/** Monday 2026-10-12 10:00 UTC. */
const MONDAY = Date.UTC(2026, 9, 12, 10);

const config: DungeonConfig = DungeonConfigSchema.parse({
  resetHourUtc: 4,
  halls: [{ regionId: "hall_fire", kind: "essence", elementId: "fire", openDays: [2, 6, 0], minAccountLevel: 5 }],
});

describe("Dungeon schedule", () => {
  it("uses the game day that starts at the reset hour", () => {
    assert.equal(gameWeekday(new Date(MONDAY), 4), 1);
    // 02:00 on Tuesday is still Monday's game day when days start at 04:00.
    assert.equal(gameWeekday(new Date(Date.UTC(2026, 9, 13, 2)), 4), 1);
    assert.equal(gameWeekday(new Date(Date.UTC(2026, 9, 13, 5)), 4), 2);
  });

  it("gates halls by weekday and account level", () => {
    const hall = config.halls[0];
    assert.equal(isHallOpen(hall, new Date(MONDAY), 4), false);
    assert.equal(evaluateDungeonGate(config, "hall_fire", 10, new Date(MONDAY))?.code, "DUNGEON_CLOSED");
    const tuesday = new Date(Date.UTC(2026, 9, 13, 12));
    assert.equal(evaluateDungeonGate(config, "hall_fire", 4, tuesday)?.code, "DUNGEON_LEVEL_LOCKED");
    assert.equal(evaluateDungeonGate(config, "hall_fire", 5, tuesday), null);
    assert.equal(evaluateDungeonGate(config, "r1", 1, new Date(MONDAY)), null, "story regions are never gated");
  });

  it("parses Unity exports (PascalCase, duplicates, defaults)", () => {
    const parsed = parseDungeonConfig(JSON.stringify({ ResetHourUtc: 2, Halls: [{ RegionId: "h", OpenDays: [6, 0, 6], Kind: "Rune" }] }));
    assert.equal(parsed.resetHourUtc, 2);
    assert.deepEqual(parsed.halls[0].openDays, [0, 6]);
    assert.equal(parsed.halls[0].kind, "rune");
    assert.equal(parsed.halls[0].minAccountLevel, 1);
    assert.deepEqual(DungeonConfigSchema.parse({ halls: [{ regionId: "x" }] }).halls[0].openDays, [0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("Dungeon unlock rules", () => {
  const cleared = (regionId: string, stageId: string, difficulty: "Easy" | "Normal" = "Easy") =>
    ({ regionId, stageId, difficulty, clears: 1, bestClearMs: null });

  it("unlocks floors one by one, Easy only, outside the story chain", () => {
    assert.equal(evaluateStageUnlock(catalog, [], "hall_fire", "b1", "Easy"), null);
    assert.equal(evaluateStageUnlock(catalog, [], "hall_fire", "b2", "Easy")?.code, "STAGE_LOCKED");
    assert.equal(evaluateStageUnlock(catalog, [cleared("hall_fire", "b1")], "hall_fire", "b2", "Easy"), null);
    assert.equal(evaluateStageUnlock(catalog, [cleared("hall_fire", "b1")], "hall_fire", "b1", "Normal")?.code, "DIFFICULTY_LOCKED");
  });

  it("story regions skip dungeon halls", () => {
    // r2 follows r1 directly: the hall between them in maps.json is not part of the chain.
    assert.equal(evaluateStageUnlock(catalog, [cleared("r1", "s1")], "r2", "s1", "Easy"), null);
    // Normal needs every story stage on Easy, not the dungeon floors.
    const story = [cleared("r1", "s1"), cleared("r2", "s1")];
    assert.equal(evaluateStageUnlock(catalog, story, "r1", "s1", "Normal"), null);
  });
});

describe("MapService with the dungeon gate", () => {
  function setup(level: number, nowMs: number) {
    const wallets = new InMemoryWalletRepository();
    const characters = new InMemoryCharacterRepository();
    const battles = new InMemoryPveBattleRepository();
    const progress = new InMemoryMapProgressRepository();
    const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(battles).register(progress);
    const clock = new FixedClock(nowMs);
    const currencies = currencyRulesOf([{ id: "energy" }]);
    const ledger = new WalletLedger(wallets, currencies, clock);
    const economy = new EconomyService(wallets, ledger, currencies, uow, clock);
    const maps = { catalog: () => catalog, getStage: (r: string, s: string) => catalog.regions.find((x) => x.id === r)?.stages.find((x) => x.id === s) };
    const dungeons = new DungeonService({ config: () => config, maps, accountLevel: async () => level, clock });
    const service = new MapService(progress, maps, characters, ledger, economy, battles, uow, dungeons);
    characters.add(USER, { uid: "U1", characterId: "c1", stars: 2, level: 1 });
    wallets.set(USER, "energy", 30);
    return { service, dungeons, wallets };
  }

  const request = { regionId: "hall_fire", stageId: "b1", difficulty: "Easy" as const, uidsInSlots: ["U1"], leaderSlotIndex: 0 };

  it("refuses closed halls and low levels before paying", async () => {
    const closed = setup(10, MONDAY);
    await assert.rejects(closed.service.validateStageStart(USER, request), (error: any) => error.errorCode === "DUNGEON_CLOSED");
    assert.equal(closed.wallets.amount(USER, "energy"), 30);

    const lowLevel = setup(1, Date.UTC(2026, 9, 13, 12));
    await assert.rejects(lowLevel.service.validateStageStart(USER, request), (error: any) => error.errorCode === "DUNGEON_LEVEL_LOCKED");
  });

  it("refuses a stage without a scene name before paying", async () => {
    const stage = catalog.regions[0].stages[0];
    const scene = stage.scene;
    stage.scene = undefined;
    try {
      const open = setup(10, Date.UTC(2026, 9, 13, 12));
      await assert.rejects(open.service.validateStageStart(USER, { ...request, regionId: "r1", stageId: "s1" }), (error: any) => error.errorCode === "STAGE_SCENE_MISSING");
      assert.equal(open.wallets.amount(USER, "energy"), 30);
    } finally {
      stage.scene = scene;
    }
  });

  it("issues the ticket on an open day and reports the schedule", async () => {
    const open = setup(10, Date.UTC(2026, 9, 13, 12));
    const reply = await open.service.validateStageStart(USER, request);
    assert.equal(reply.ok, true);
    assert.equal(open.wallets.amount(USER, "energy"), 27);

    const status = await open.dungeons.status(USER);
    assert.deepEqual(status.halls.map((hall) => [hall.regionId, hall.open, hall.levelLocked, hall.openDays]), [["hall_fire", true, false, [0, 2, 6]]]);
    assert.equal(status.nextResetAtUnix, Date.UTC(2026, 9, 14, 4) / 1000);
  });
});

describe("Dungeon drops", () => {
  const dropStage = floor("b1", {
    rewards: [{
      difficulty: "Easy",
      currencies: [],
      firstClearCurrencies: [],
      unitExp: 0,
      accountExp: 0,
      dropTable: {
        id: "hall",
        rune: { chance: 1, stars: [{ stars: 3, weight: 1 }], grades: [{ grade: 2, weight: 1 }, { grade: 4, weight: 1 }], sets: ["Guard", "Swift"] },
        items: [],
      },
      randomDrops: [
        { currencyId: "fire_low", min: 2, max: 4, chance: 1 },
        { currencyId: "fire_high", min: 1, max: 1, chance: 0.5 },
      ],
    }],
  });

  it("rolls each random drop and restricts the rune set", async () => {
    const wallets = new InMemoryWalletRepository();
    const characters = new InMemoryCharacterRepository();
    const battles = new InMemoryPveBattleRepository();
    const progress = new InMemoryMapProgressRepository();
    const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(battles).register(progress);
    const clock = new FixedClock(MONDAY);
    const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "fire_low" }, { id: "fire_high" }]), clock);
    const progression = new MonsterProgression({
      starTiers: () => [],
      powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
      evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
    });
    const specs: Array<{ tier: number; quality?: number; setId?: string }> = [];
    const runes = { grantRunes: async (_s: unknown, _u: string, list: typeof specs) => { specs.push(...list); return list.map((_, i) => ({ uid: `r${i}` })); } } as unknown as RuneService;
    // float: drop 1 (always), drop 2 fails (0.7 >= 0.5), rune chance passes, stars (single), grade 0.8 → 4;
    // int: amount offset 1, set index 1.
    const floats = [0.1, 0.7, 0.2, 0.5, 0.8];
    const ints = [1, 1];
    const random: RandomSource = { float: () => floats.shift() ?? 0, int: () => ints.shift() ?? 0 };
    const rewards = new BattleRewardService(
      battles, progress, { catalog: () => catalog, getStage: () => dropStage },
      ledger, characters, progression, runes, new RosterCache(noCache), new RuneCache(noCache), random, uow, clock, noAudit,
    );
    await battles.createTicket({ id: "t1", userId: USER, regionId: "hall_fire", stageId: "b1", difficulty: "Easy", currencyId: "energy", energySpent: 3 }, SESSION);
    await battles.consumeTicket(USER, { regionId: "hall_fire", stageId: "b1", difficulty: "Easy" }, "B1", new Date(0), null, SESSION);

    const result = await rewards.settle(USER, { battleId: "B1", victory: true, unitUids: [], clearMs: null });
    assert.equal(result.victory, true);
    if (!result.victory) return;
    assert.deepEqual(result.currencies, [{ currencyId: "fire_low", amount: 3 }]);
    assert.equal(wallets.amount(USER, "fire_high"), 0);
    assert.deepEqual(specs.map((spec) => [spec.tier, spec.quality, spec.setId]), [[3, 4, "Swift"]]);
  });
});
