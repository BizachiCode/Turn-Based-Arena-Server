import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { AppError } from "../src/shared/errors/app-error";
import { getHomeCatalog, reloadHomeCatalogFromFile, type HomeBuildableCfg, type HomeCatalog, type HomeProductionCfg } from "../src/config/HomeCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { isActiveProduction, nextAnchor, storedAt } from "../src/modules/home/home-production";
import { HomeMessageSchema } from "../src/modules/home/home.validation";
import { HomeService } from "../src/modules/home/home.service";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { currencyRulesOf, homeRulesOf, InMemoryBuildingInventory, InMemoryCharacterRepository, InMemoryHomeProductionRepository, InMemoryHomeRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";
const OTHER = "user-2";
const START_MS = Date.UTC(2026, 9, 7);
const HOUR = 3600;

const cfg = (extra: Partial<HomeProductionCfg> = {}): HomeProductionCfg => ({ kind: "currency", currencyId: "DM", amountPerHour: 1, capacity: 12, unitSlots: 0, ...extra });
const expCfg = (extra: Partial<HomeProductionCfg> = {}): HomeProductionCfg => cfg({ kind: "unitExp", currencyId: "", amountPerHour: 600, capacity: 7200, unitSlots: 3, ...extra });

describe("Home production formula", () => {
  it("stores nothing before the first full unit and nothing when the anchor is in the future", () => {
    assert.equal(storedAt(cfg(), 1000, 1000), 0);
    assert.equal(storedAt(cfg(), 1000, 1000 + HOUR - 1), 0);
    assert.equal(storedAt(cfg(), 1000, 500), 0);
  });

  it("accrues whole units and floors the partial one (integer math)", () => {
    assert.equal(storedAt(cfg(), 0, HOUR), 1);
    assert.equal(storedAt(cfg(), 0, 5 * HOUR + 3599), 5);
    assert.equal(storedAt(cfg({ amountPerHour: 400, capacity: 4800 }), 0, 5400), 600);
    assert.equal(storedAt(cfg({ amountPerHour: 7 }), 100, 1100), 1); // floor(7000 / 3600)
  });

  it("caps the stored amount at the capacity, also with huge elapsed times and rates", () => {
    assert.equal(storedAt(cfg(), 0, 100 * HOUR), 12);
    assert.equal(storedAt(cfg({ amountPerHour: 2_000_000_000, capacity: 2_000_000_000 }), 0, 1_800_000_000), 2_000_000_000);
    assert.equal(storedAt(cfg({ amountPerHour: 1_999_999_999, capacity: 2_100_000_000 }), 0, 1_800_000_000), 2_100_000_000);
  });

  it("keeps the remainder: the anchor advances by the time the collected units took", () => {
    const rate = cfg({ amountPerHour: 7, capacity: 100 });
    assert.equal(storedAt(rate, 1000, 2000), 1);
    assert.equal(nextAnchor(rate, 1000, 2000, 1), 1000 + 515); // ceil(3600 / 7)
    assert.equal(nextAnchor(cfg({ amountPerHour: 400, capacity: 4800 }), 0, 3630, 403), 3627); // 3 s of the next unit kept
    assert.equal(nextAnchor(cfg(), 0, 2 * HOUR + 10, 2), 2 * HOUR);
  });

  it("restarts from now when the building was full and never moves the anchor past now", () => {
    assert.equal(nextAnchor(cfg(), 0, 50 * HOUR, 12), 50 * HOUR);
    assert.equal(nextAnchor(cfg(), 0, 50 * HOUR, 99), 50 * HOUR);
    assert.equal(nextAnchor(cfg({ amountPerHour: 400, capacity: 4800 }), 5400, 5400, 600), 5400);
    assert.equal(nextAnchor(cfg(), 100, 100, 0), 100);
    assert.equal(nextAnchor(cfg({ amountPerHour: 400, capacity: 4800 }), 0, 6000, 600), 5400); // ceil(600*3600/400) = 5400 < now
  });

  it("activates only well-formed blocks", () => {
    assert.equal(isActiveProduction(cfg()), true);
    assert.equal(isActiveProduction(expCfg()), true);
    assert.equal(isActiveProduction(undefined), false);
    assert.equal(isActiveProduction(cfg({ amountPerHour: 0 })), false);
    assert.equal(isActiveProduction(cfg({ capacity: 0 })), false);
    assert.equal(isActiveProduction(cfg({ currencyId: "  " })), false);
    assert.equal(isActiveProduction(expCfg({ unitSlots: 0 })), false);
    assert.equal(isActiveProduction({ ...cfg(), kind: "other" as never }), false);
  });
});

describe("Home catalog production block", () => {
  it("keeps active blocks and drops malformed or inactive ones", async () => {
    const original = getHomeCatalog();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "home-production-"));
    const file = path.join(dir, "homes.json");
    try {
      const entry = (id: string, production: unknown) => ({ id, production, footprints: [] });
      fs.writeFileSync(file, JSON.stringify({
        version: "1", defaultIslandId: "main", islands: [],
        buildables: [
          entry("good_currency", { kind: "currency", currencyId: "DM", amountPerHour: 1, capacity: 12, unitSlots: 0 }),
          entry("good_exp", { kind: "unitExp", amountPerHour: 600, capacity: 7200, unitSlots: 99 }),
          entry("no_currency", { kind: "currency", currencyId: " ", amountPerHour: 1, capacity: 12 }),
          entry("zero_rate", { kind: "currency", currencyId: "DM", amountPerHour: 0, capacity: 12 }),
          entry("zero_cap", { kind: "currency", currencyId: "DM", amountPerHour: 1, capacity: 0 }),
          entry("no_slots", { kind: "unitExp", amountPerHour: 600, capacity: 7200, unitSlots: 0 }),
          entry("bad_kind", { kind: "magic", currencyId: "DM", amountPerHour: 1, capacity: 12 }),
          entry("not_object", "currency"),
          entry("absent", undefined),
        ],
      }), "utf8");

      const loaded = await reloadHomeCatalogFromFile(file);
      const production = (id: string) => loaded.buildables.find((buildable) => buildable.id === id)?.production;
      assert.deepEqual(production("good_currency"), { kind: "currency", currencyId: "DM", amountPerHour: 1, capacity: 12, unitSlots: 0 });
      assert.deepEqual(production("good_exp"), { kind: "unitExp", currencyId: "", amountPerHour: 600, capacity: 7200, unitSlots: 10 });
      for (const id of ["no_currency", "zero_rate", "zero_cap", "no_slots", "bad_kind", "not_object", "absent"]) {
        assert.equal(production(id), undefined, id);
      }
    } finally {
      fs.writeFileSync(file, JSON.stringify(original), "utf8");
      await reloadHomeCatalogFromFile(file);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Home production messages", () => {
  const parse = (payload: unknown) => HomeMessageSchema.safeParse(payload);

  it("accepts collect_production and set_production_units with 0..10 distinct uids", () => {
    assert.equal(parse({ type: "collect_production", islandId: "main", instanceId: "a" }).success, true);
    assert.equal(parse({ type: "set_production_units", islandId: "main", instanceId: "a", uids: [] }).success, true);
    const ten = Array.from({ length: 10 }, (_, index) => `u${index}`);
    assert.equal(parse({ type: "set_production_units", islandId: "main", instanceId: "a", uids: ten }).success, true);
  });

  it("rejects duplicates, more than 10 uids, bad uids, missing fields and unknown keys", () => {
    assert.equal(parse({ type: "set_production_units", islandId: "main", instanceId: "a", uids: ["u1", "u1"] }).success, false);
    const eleven = Array.from({ length: 11 }, (_, index) => `u${index}`);
    assert.equal(parse({ type: "set_production_units", islandId: "main", instanceId: "a", uids: eleven }).success, false);
    assert.equal(parse({ type: "set_production_units", islandId: "main", instanceId: "a", uids: [""] }).success, false);
    assert.equal(parse({ type: "set_production_units", islandId: "main", instanceId: "a", uids: ["x".repeat(81)] }).success, false);
    assert.equal(parse({ type: "set_production_units", islandId: "main", instanceId: "a" }).success, false);
    assert.equal(parse({ type: "collect_production", islandId: "main" }).success, false);
    assert.equal(parse({ type: "collect_production", islandId: "main", instanceId: "a", extra: 1 }).success, false);
  });
});

const buildable = (id: string, extra: Partial<HomeBuildableCfg> = {}): HomeBuildableCfg => ({
  id, displayName: id, kind: "Building", canPurchase: true, canSpawnAsIslandDefault: true, canMove: true, canRemove: true,
  isUnique: false, countsTowardsLimit: true, maxCount: 0, unlockLevel: 0, placeCostAmount: 0,
  removeCostAmount: 0, rotationStepDegrees: 90, footprints: [{ rotationIndex: 0, yawDegrees: 0, cells: [{ x: 0, z: 0 }] }],
  ...extra,
});

const cells = (count: number) => Array.from({ length: count }, (_, x) => ({ x, z: 0, flags: 1 }));

const catalog: HomeCatalog = {
  version: "1", generatedAtUnix: 0, defaultIslandId: "main",
  buildables: [
    buildable("hut"),
    buildable("tower", { production: cfg() }),
    buildable("gold_mine", { production: cfg({ currencyId: "gold", amountPerHour: 400, capacity: 4800 }) }),
    buildable("training", { production: expCfg() }),
    buildable("wizard", { production: expCfg({ amountPerHour: 1500, capacity: 18000, unitSlots: 2 }) }),
    buildable("broken", { production: { ...cfg(), amountPerHour: 0 } }),
  ],
  islands: [
    {
      id: "main", displayName: "main", unlockedByDefault: true, unlockLevel: 0, unlockCostAmount: 0, order: 0,
      gridSizeX: 12, gridSizeZ: 1, cellSize: 1, cells: cells(12),
      defaultPlacements: [
        { templateInstanceId: "tower-1", buildableId: "tower", x: 0, z: 0, yawDegrees: 0 },
        { templateInstanceId: "wizard-1", buildableId: "wizard", x: 1, z: 0, yawDegrees: 0 },
      ],
    },
    {
      id: "east", displayName: "east", unlockedByDefault: false, unlockLevel: 0, unlockCostAmount: 0, order: 1,
      gridSizeX: 3, gridSizeZ: 1, cellSize: 1, cells: cells(3), defaultPlacements: [],
    },
  ],
};

function setup() {
  const wallets = new InMemoryWalletRepository();
  const homeRepo = new InMemoryHomeRepository();
  const inventory = new InMemoryBuildingInventory();
  const productions = new InMemoryHomeProductionRepository();
  const characters = new InMemoryCharacterRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(homeRepo).register(inventory).register(productions).register(characters);
  const clock = new FixedClock(START_MS);
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "gold" }, { id: "DM" }]), clock);
  const progression = new MonsterProgression({
    starTiers: () => [{ stars: 2, maxLevel: 5, expPerLevel: [100, 100, 100, 100] }],
    powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
  });
  const homes = new HomeService(homeRepo, inventory, homeRulesOf(catalog), ledger, async () => 1, uow, clock, productions, characters, progression, new RosterCache(noCache));
  const advance = (seconds: number) => clock.advance(seconds * 1000);
  return { wallets, homes, homeRepo, productions, characters, clock, advance, now: () => clock.nowUnix() };
}

type Env = ReturnType<typeof setup>;

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
let nextX = 2;

/** Places a building (no build cost in this catalog) on a free cell of the main island and returns its instance id. */
async function placeAt(env: Env, definitionId: string, userId = USER): Promise<string> {
  const x = nextX++;
  const placed = await env.homes.placeObject(userId, { islandId: "main", definitionId, originX: x, originZ: 0, yawDegrees: 0 });
  const placement = placed.snapshot!.islands[0].placements.find((entry) => !entry.isTemplateObject && entry.x === x);
  assert.ok(placement);
  return placement.instanceId;
}

const placementOf = async (env: Env, instanceId: string, userId = USER) =>
  (await env.homes.getSnapshot(userId)).islands[0].placements.find((entry) => entry.instanceId === instanceId);

const collect = (env: Env, instanceId: string, userId = USER, islandId = "main") => env.homes.collectProduction(userId, { islandId, instanceId });
const station = (env: Env, instanceId: string, uids: string[], userId = USER) =>
  env.homes.setProductionUnits(userId, { islandId: "main", instanceId, uids });

describe("HomeService production snapshot and placement", () => {
  beforeEach(() => { nextX = 2; });

  it("gives producing placements a production state and leaves the others without one", async () => {
    const env = setup();
    const hut = await placeAt(env, "hut");
    const broken = await placeAt(env, "broken");
    const tower = await placeAt(env, "tower");

    assert.equal((await placementOf(env, hut))?.production, undefined);
    assert.equal((await placementOf(env, broken))?.production, undefined);
    assert.deepEqual((await placementOf(env, tower))?.production, { sinceUnix: env.now(), units: [] });
  });

  it("a template building without a stored row starts full (sinceUnix 0) and a new one starts empty", async () => {
    const env = setup();
    assert.deepEqual((await placementOf(env, "tower-1"))?.production, { sinceUnix: 0, units: [] });
    assert.deepEqual((await placementOf(env, "wizard-1"))?.production, { sinceUnix: 0, units: [] });

    const tower = await placeAt(env, "tower");
    assert.deepEqual(env.productions.find(USER, tower), { instanceId: tower, islandId: "main", buildableId: "tower", sinceUnix: env.now(), units: [] });
    await assert.rejects(collect(env, tower), isError("HOME_NOTHING_TO_COLLECT"));
    env.advance(3 * HOUR);
    assert.equal((await collect(env, tower)).collected?.amount, 3);
  });

  it("does not create rows for non-producing buildables, removes the row with the building and keeps it on move", async () => {
    const env = setup();
    const hut = await placeAt(env, "hut");
    assert.equal(env.productions.find(USER, hut), undefined);

    const mine = await placeAt(env, "gold_mine");
    env.advance(HOUR);
    await env.homes.moveObject(USER, { islandId: "main", instanceId: mine, originX: 11, originZ: 0, yawDegrees: 0 });
    assert.equal(env.productions.find(USER, mine)?.sinceUnix, START_MS / 1000);
    assert.equal((await placementOf(env, mine))?.production?.sinceUnix, START_MS / 1000);

    await env.homes.removeObject(USER, { islandId: "main", instanceId: mine });
    assert.equal(env.productions.find(USER, mine), undefined);
    assert.equal(await placementOf(env, mine), undefined);
  });

  it("removing a template building drops its row and a rolled back placement leaves no row", async () => {
    const env = setup();
    await collect(env, "tower-1");
    assert.ok(env.productions.find(USER, "tower-1"));
    await env.homes.removeObject(USER, { islandId: "main", instanceId: "tower-1" });
    assert.equal(env.productions.find(USER, "tower-1"), undefined);

    await assert.rejects(env.homes.placeObject(USER, { islandId: "main", definitionId: "tower", originX: 99, originZ: 0, yawDegrees: 0 }), isError("HOME_OUT_OF_BOUNDS"));
    assert.deepEqual(env.productions.rows, []);
  });
});

describe("HomeService collectProduction (currency)", () => {
  beforeEach(() => { nextX = 2; });

  it("pays the stored amount of a template building that starts full, then has nothing to collect", async () => {
    const env = setup();
    const first = await collect(env, "tower-1");
    assert.equal(first.ok, true);
    assert.deepEqual(first.collected, { currencyId: "DM", amount: 12 });
    assert.deepEqual(first.units, []);
    assert.equal(first.wallet?.DM, 12);
    assert.equal(env.wallets.amount(USER, "DM"), 12);
    assert.deepEqual((await placementOf(env, "tower-1"))?.production, { sinceUnix: env.now(), units: [] });
    assert.equal(first.snapshot?.revision, 1);

    await assert.rejects(collect(env, "tower-1"), isError("HOME_NOTHING_TO_COLLECT"));
    assert.equal(env.wallets.amount(USER, "DM"), 12);
  });

  it("collects a partial amount and keeps the remainder toward the next unit", async () => {
    const env = setup();
    const mine = await placeAt(env, "gold_mine");
    const placedAt = env.now();
    env.advance(HOUR + 30); // 403.33 gold

    const reply = await collect(env, mine);
    assert.deepEqual(reply.collected, { currencyId: "gold", amount: 403 });
    assert.equal(reply.wallet?.gold, 403);
    assert.equal((await placementOf(env, mine))?.production?.sinceUnix, placedAt + 3627);
  });

  it("caps at the capacity and restarts the accrual from now", async () => {
    const env = setup();
    const mine = await placeAt(env, "gold_mine");
    env.advance(100 * HOUR);

    const reply = await collect(env, mine);
    assert.deepEqual(reply.collected, { currencyId: "gold", amount: 4800 });
    assert.equal((await placementOf(env, mine))?.production?.sinceUnix, env.now());
    await assert.rejects(collect(env, mine), isError("HOME_NOTHING_TO_COLLECT"));
  });

  it("validates island, lock, object and production before paying anything", async () => {
    const env = setup();
    const hut = await placeAt(env, "hut");
    await assert.rejects(collect(env, "tower-1", USER, "nope"), isError("HOME_ISLAND_NOT_FOUND"));
    await assert.rejects(collect(env, "tower-1", USER, "east"), isError("HOME_ISLAND_LOCKED"));
    await assert.rejects(collect(env, "missing"), isError("HOME_OBJECT_NOT_FOUND"));
    await assert.rejects(collect(env, hut), isError("HOME_NO_PRODUCTION"));
    await assert.rejects(collect(env, hut, OTHER), isError("HOME_OBJECT_NOT_FOUND"));
    assert.equal(env.wallets.amount(USER, "DM"), 0);
  });

  it("keeps each player's production separate", async () => {
    const env = setup();
    await collect(env, "tower-1");
    const other = await collect(env, "tower-1", OTHER);
    assert.equal(other.collected?.amount, 12);
    assert.equal(env.wallets.amount(OTHER, "DM"), 12);
  });
});

describe("HomeService unit EXP production", () => {
  beforeEach(() => { nextX = 2; });

  function withMonsters(env: Env) {
    env.characters.add(USER, { uid: "u1", characterId: "hero", stars: 2 });
    env.characters.add(USER, { uid: "u2", characterId: "mage", stars: 2, level: 2, currentExp: 40 });
    env.characters.add(USER, { uid: "u3", characterId: "tank", stars: 2 });
    env.characters.add(OTHER, { uid: "x1", characterId: "hero", stars: 2 });
  }

  it("stations monsters, then pays the stored EXP to each of them on collect", async () => {
    const env = setup();
    withMonsters(env);
    const gym = await placeAt(env, "training");

    const set = await station(env, gym, ["u1", "u2"]);
    assert.equal(set.ok, true);
    assert.equal(set.wallet, undefined);
    assert.deepEqual(set.units, []);
    assert.deepEqual((await placementOf(env, gym))?.production, { sinceUnix: env.now(), units: ["u1", "u2"] });

    env.advance(900); // 600/h -> 150 EXP each
    const reply = await collect(env, gym);
    assert.equal(reply.collected, null);
    assert.deepEqual(reply.units, [
      { uid: "u1", characterId: "hero", expGained: 150, level: 2, currentExp: 50, leveledUp: true },
      { uid: "u2", characterId: "mage", expGained: 150, level: 3, currentExp: 90, leveledUp: true },
    ]);
    assert.deepEqual([env.characters.records.get("u1")?.level, env.characters.records.get("u1")?.currentExp], [2, 50]);
    assert.deepEqual([env.characters.records.get("u2")?.level, env.characters.records.get("u2")?.currentExp], [3, 90]);
    assert.deepEqual((await placementOf(env, gym))?.production, { sinceUnix: env.now(), units: ["u1", "u2"] });
    await assert.rejects(collect(env, gym), isError("HOME_NOTHING_TO_COLLECT"));
  });

  it("works on a template building and reports the EXP actually consumed at the level cap", async () => {
    const env = setup();
    withMonsters(env);
    await station(env, "wizard-1", ["u1"]);
    assert.equal(env.productions.find(USER, "wizard-1")?.islandId, "main");

    env.advance(10 * HOUR); // 1500/h -> 15000 EXP stored, far more than the monster can use
    const reply = await collect(env, "wizard-1");
    assert.deepEqual(reply.units, [{ uid: "u1", characterId: "hero", expGained: 400, level: 5, currentExp: 0, leveledUp: true }]);
  });

  it("has nothing to collect without stationed monsters or before the first EXP point", async () => {
    const env = setup();
    withMonsters(env);
    const gym = await placeAt(env, "training");
    env.advance(HOUR);
    await assert.rejects(collect(env, gym), isError("HOME_NOTHING_TO_COLLECT"));

    await station(env, gym, ["u1"]);
    await assert.rejects(collect(env, gym), isError("HOME_NOTHING_TO_COLLECT")); // 0 seconds elapsed
    assert.equal(env.characters.records.get("u1")?.currentExp, 0);
  });

  it("ignores stationed monsters that no longer exist and drops them from the building", async () => {
    const env = setup();
    withMonsters(env);
    const gym = await placeAt(env, "training");
    await station(env, gym, ["u1", "u2", "u3"]);
    await env.characters.deleteCharacters(USER, ["u2"]);

    env.advance(900);
    const reply = await collect(env, gym);
    assert.deepEqual(reply.units?.map((unit) => unit.uid), ["u1", "u3"]);
    assert.deepEqual((await placementOf(env, gym))?.production?.units, ["u1", "u3"]);

    await env.characters.deleteCharacters(USER, ["u1", "u3"]);
    env.advance(HOUR);
    await assert.rejects(collect(env, gym), isError("HOME_NOTHING_TO_COLLECT"));
  });

  it("settles the pending EXP of the current monsters before replacing them", async () => {
    const env = setup();
    withMonsters(env);
    const gym = await placeAt(env, "training");
    await station(env, gym, ["u1"]);

    env.advance(1800); // 300 EXP
    const swap = await station(env, gym, ["u2", "u3"]);
    assert.deepEqual(swap.units, [{ uid: "u1", characterId: "hero", expGained: 300, level: 4, currentExp: 0, leveledUp: true }]);
    assert.equal(env.characters.records.get("u1")?.level, 4);
    assert.equal(env.characters.records.get("u2")?.currentExp, 40); // the new monsters start accruing now
    assert.deepEqual(env.productions.find(USER, gym)?.units, ["u2", "u3"]);
    assert.equal(env.productions.find(USER, gym)?.sinceUnix, env.now());

    const empty = await station(env, gym, []); // nothing pending is not an error
    assert.deepEqual(empty.units, []);
    assert.deepEqual((await placementOf(env, gym))?.production, { sinceUnix: env.now(), units: [] });
  });

  it("enforces the slots, ownership, the one-building rule and the producer kind", async () => {
    const env = setup();
    withMonsters(env);
    const gym = await placeAt(env, "training");
    const tower = await placeAt(env, "tower");
    const hut = await placeAt(env, "hut");

    await assert.rejects(station(env, "wizard-1", ["u1", "u2", "u3"]), isError("HOME_PRODUCTION_SLOTS_FULL"));
    await assert.rejects(station(env, gym, ["u1", "ghost"]), isError("HOME_UNIT_NOT_FOUND"));
    await assert.rejects(station(env, gym, ["x1"]), isError("HOME_UNIT_NOT_FOUND")); // another player's monster
    await assert.rejects(station(env, tower, ["u1"]), isError("HOME_NO_PRODUCTION")); // currency producer
    await assert.rejects(station(env, hut, ["u1"]), isError("HOME_NO_PRODUCTION"));
    await assert.rejects(station(env, "missing", ["u1"]), isError("HOME_OBJECT_NOT_FOUND"));
    await assert.rejects(env.homes.setProductionUnits(USER, { islandId: "nope", instanceId: gym, uids: [] }), isError("HOME_ISLAND_NOT_FOUND"));
    await assert.rejects(env.homes.setProductionUnits(USER, { islandId: "east", instanceId: gym, uids: [] }), isError("HOME_ISLAND_LOCKED"));
    assert.deepEqual(env.productions.find(USER, gym)?.units, []);

    await station(env, gym, ["u1", "u2"]);
    await assert.rejects(station(env, "wizard-1", ["u2"]), isError("HOME_UNIT_BUSY"));
    await station(env, gym, ["u2", "u3"]); // the same building may keep and rearrange its monsters
    await station(env, "wizard-1", ["u1"]); // u1 was released by the previous call
    await assert.rejects(station(env, gym, ["u1"]), isError("HOME_UNIT_BUSY"));
    assert.deepEqual(env.productions.find(USER, gym)?.units, ["u2", "u3"]);
  });

  it("does not let a stale row of a building that no longer produces keep a monster busy", async () => {
    const env = setup();
    withMonsters(env);
    const gym = await placeAt(env, "training");
    await station(env, gym, ["u1"]);
    catalog.buildables.find((entry) => entry.id === "training")!.production = undefined;
    try {
      await station(env, "wizard-1", ["u1"]);
    } finally {
      catalog.buildables.find((entry) => entry.id === "training")!.production = expCfg();
    }
    assert.deepEqual(env.productions.find(USER, "wizard-1")?.units, ["u1"]);
  });

  it("leaves EXP, units and anchor untouched when the request is refused", async () => {
    const env = setup();
    withMonsters(env);
    const gym = await placeAt(env, "training");
    await station(env, gym, ["u1"]);
    env.advance(900);

    await assert.rejects(station(env, gym, ["u1", "ghost"]), isError("HOME_UNIT_NOT_FOUND"));
    assert.equal(env.characters.records.get("u1")?.currentExp, 0);
    assert.equal(env.productions.find(USER, gym)?.sinceUnix, env.now() - 900);
  });
});
