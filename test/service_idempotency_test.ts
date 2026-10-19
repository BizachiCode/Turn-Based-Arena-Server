import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error";
import { DrizzleUnitOfWork } from "../src/infrastructure/database/drizzle-unit-of-work";
import type { Database } from "../src/infrastructure/database/drizzle";
import { Idempotency, REQUEST_ID_PATTERN, RequestIdSchema } from "../src/shared/kernel/idempotency";
import type { DbSession, UnitOfWork } from "../src/shared/kernel/unit-of-work";
import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { createSeededRandom } from "../src/shared/kernel/random";
import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";
import type { SummonScroll } from "../src/config/SummonCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression, type ProgressionRulesSource } from "../src/modules/progression/progression.rules";
import { CharacterGrantService } from "../src/modules/roster/character-grant.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RosterService } from "../src/modules/roster/roster.service";
import type { RosterRules } from "../src/modules/roster/roster.ports";
import { SummonService } from "../src/modules/summon/summon.service";
import { AwakeningService } from "../src/modules/awakening/awakening.service";
import { MapService } from "../src/modules/map/map.service";
import { EconomyService } from "../src/modules/economy/economy.service";
import type { MapCatalog, MapStage } from "../src/config/MapCatalog";
import { SummonSchema } from "../src/modules/summon/summon.validation";
import { PowerUpSchema, SellSchema } from "../src/modules/roster/roster.validation";
import { UpgradeSchema } from "../src/modules/rune/rune.validation";
import { AwakenSchema } from "../src/modules/awakening/awakening.validation";
import { StageStartSchema } from "../src/modules/map/map.validation";
import { currencyRulesOf, InMemoryCharacterRepository, InMemoryMapProgressRepository, InMemoryPveBattleRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";
import { InMemoryRequestResultStore } from "./support/idempotency-fakes";

const USER = "user-1";
const OTHER = "user-2";
const SESSION = { kind: "db-session" } as DbSession;

const isConflict = (error: unknown) => error instanceof AppError && error.errorCode === "REQUEST_ID_CONFLICT";

describe("Request id (zod)", () => {
  it("accepts 1..64 characters of [A-Za-z0-9_-] and rejects anything else", () => {
    for (const ok of ["a", "A1_-z", "x".repeat(64), "0f8fad5b-d9cb-469f-a165-70867728950e"]) assert.equal(RequestIdSchema.safeParse(ok).success, true, ok);
    for (const bad of ["", "x".repeat(65), "has space", "semi;colon", "emoji\u{1F600}", "a/b", "a.b"]) assert.equal(RequestIdSchema.safeParse(bad).success, false, bad);
    assert.equal(RequestIdSchema.safeParse(undefined).success, true, "optional");
    assert.equal(REQUEST_ID_PATTERN.test("ok_id-1"), true);
  });

  it("is an optional field of every idempotent request", () => {
    assert.equal(SummonSchema.safeParse({ scrollId: "s", requestId: "r1" }).success, true);
    assert.equal(SummonSchema.safeParse({ scrollId: "s", requestId: "bad id" }).success, false);
    assert.equal(PowerUpSchema.safeParse({ targetUid: "t", fodderUids: ["f"], requestId: "r1" }).success, true);
    assert.equal(SellSchema.safeParse({ uids: ["a"], requestId: "r1" }).success, true);
    assert.equal(UpgradeSchema.safeParse({ runeUid: "r", requestId: "r1" }).success, true);
    assert.equal(AwakenSchema.safeParse({ characterUid: "c", requestId: "r1" }).success, true);
    assert.equal(StageStartSchema.safeParse({ regionId: "r", stageId: "s", difficulty: "Easy", uidsInSlots: ["a"], leaderSlotIndex: 0, requestId: "r1" }).success, true);
    assert.equal(StageStartSchema.safeParse({ regionId: "r", stageId: "s", difficulty: "Easy", uidsInSlots: ["a"], leaderSlotIndex: 0, requestId: "no way" }).success, false);
  });
});

describe("Idempotency", () => {
  function plain() {
    const store = new InMemoryRequestResultStore();
    const uow = new InMemoryUnitOfWork().register(store);
    return { store, uow, idempotency: new Idempotency(store, uow) };
  }

  it("runs the work once and answers the stored response (marked replayed) to a repeated id", async () => {
    const { store, idempotency } = plain();
    let runs = 0;
    const work = async () => ({ ok: true as const, n: ++runs });

    const first = await idempotency.run(USER, "req-1", "summon", work);
    assert.deepEqual(first, { value: { ok: true, n: 1 }, replayed: false });
    assert.equal(store.rows.size, 1);

    const hit = await idempotency.replay<{ ok: true; n: number }>(USER, "req-1", "summon");
    assert.deepEqual(hit, { ok: true, n: 1, replayed: true });
    assert.equal(runs, 1);
  });

  it("scopes ids by user and never mixes kinds", async () => {
    const { idempotency } = plain();
    await idempotency.run(USER, "same", "summon", async () => ({ who: USER }));
    assert.equal(await idempotency.replay(OTHER, "same", "summon"), null, "another user is not affected");
    const second = await idempotency.run(OTHER, "same", "summon", async () => ({ who: OTHER }));
    assert.deepEqual(second, { value: { who: OTHER }, replayed: false });

    await assert.rejects(idempotency.replay(USER, "same", "power_up"), isConflict);
    await assert.rejects(idempotency.run(USER, "same", "power_up", async () => ({})), isConflict);
  });

  it("stores nothing when the work fails, so a retry runs again", async () => {
    const { store, idempotency } = plain();
    let attempts = 0;
    const work = async () => {
      attempts++;
      if (attempts === 1) throw new AppError("NOT_ENOUGH_SCROLLS");
      return { ok: true as const };
    };
    await assert.rejects(idempotency.run(USER, "retry", "summon", work), (error: unknown) => error instanceof AppError && error.errorCode === "NOT_ENOUGH_SCROLLS");
    assert.equal(store.rows.size, 0, "the claim rolled back with the transaction");
    const second = await idempotency.run(USER, "retry", "summon", work);
    assert.equal(second.replayed, false);
    assert.equal(attempts, 2);
  });

  it("without a request id (or without a store) it is a plain transaction", async () => {
    const { store, idempotency } = plain();
    let runs = 0;
    await idempotency.run(USER, undefined, "summon", async () => ({ n: ++runs }));
    await idempotency.run(USER, undefined, "summon", async () => ({ n: ++runs }));
    assert.equal(runs, 2);
    assert.equal(store.rows.size, 0);
    assert.equal(await idempotency.replay(USER, undefined, "summon"), null);

    const disabled = new Idempotency(null, new InMemoryUnitOfWork());
    await disabled.run(USER, "ignored", "summon", async () => ({ n: ++runs }));
    await disabled.run(USER, "ignored", "summon", async () => ({ n: ++runs }));
    assert.equal(runs, 4);
  });

  it("two calls with the same id at the same time run the work once; the second waits and replays", async () => {
    const store = new InMemoryRequestResultStore();
    // No rollback participants: the second transaction only reads (an in-memory unit of work is not isolated).
    const uow: UnitOfWork = { transaction: (work) => work(SESSION) };
    const idempotency = new Idempotency(store, uow);
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const slow = idempotency.run(USER, "twice", "summon", async () => {
      runs++;
      await gate;
      return { ok: true as const, runs };
    });
    const racing = idempotency.run(USER, "twice", "summon", async () => {
      runs++;
      return { ok: true as const, runs };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 1, "the second call is blocked on the claim");
    release();

    const [a, b] = await Promise.all([slow, racing]);
    assert.equal(runs, 1);
    assert.deepEqual([a.replayed, b.replayed], [false, true]);
    assert.deepEqual(b.value, { ok: true, runs: 1, replayed: true });
  });

  it("a deadlock retry of the unit of work claims again and stores one result", async () => {
    const store = new InMemoryRequestResultStore();
    const database = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        const snapshot = store.snapshot();
        try {
          return await callback({ execute: async () => undefined });
        } catch (error) {
          store.restore(snapshot);
          throw error;
        }
      },
    } as unknown as Database;
    const uow = new DrizzleUnitOfWork(database, 5, { sleep: async () => undefined, random: () => 0 });
    const idempotency = new Idempotency(store, uow);
    let attempts = 0;

    const result = await idempotency.run(USER, "deadlocked", "summon", async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("Deadlock found"), { errno: 1213, code: "ER_LOCK_DEADLOCK" });
      return { ok: true as const, attempts };
    });
    assert.deepEqual(result, { value: { ok: true, attempts: 2 }, replayed: false });
    assert.equal(store.claims, 2, "the claim of the rolled back attempt was inserted again");
    assert.equal(store.rows.size, 1);
    assert.deepEqual(await idempotency.replay(USER, "deadlocked", "summon"), { ok: true, attempts: 2, replayed: true });
  });

  it("when the first of two concurrent calls fails, the second runs the work", async () => {
    const store = new InMemoryRequestResultStore();
    const uow = new InMemoryUnitOfWork().register(store);
    const idempotency = new Idempotency(store, uow);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;

    const failing = idempotency.run(USER, "flaky", "summon", async () => { await gate; throw new AppError("ROSTER_FULL"); });
    const second = idempotency.run(USER, "flaky", "summon", async () => ({ ok: true as const, runs: ++runs }));
    await new Promise((resolve) => setImmediate(resolve));
    release();

    await assert.rejects(failing, (error: unknown) => error instanceof AppError && error.errorCode === "ROSTER_FULL");
    assert.deepEqual(await second, { value: { ok: true, runs: 1 }, replayed: false });
  });
});

// ── Services ────────────────────────────────────────────────────────────

const progressionRules: ProgressionRulesSource = {
  starTiers: () => [
    { stars: 1, maxLevel: 15, expPerLevel: Array(14).fill(100) },
    { stars: 2, maxLevel: 20, expPerLevel: Array(19).fill(200) },
    { stars: 3, maxLevel: 40, expPerLevel: [] },
  ],
  powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 100, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
  evolve: () => ({ currencyId: "gold", costPerStarUnit: 50, steps: [{ fromStars: 1, toStars: 2, requiredStarPoints: 2 }] }),
};

const rosterRules: RosterRules = () => ({
  sell: { currencyId: "gold", priceByStars: [0, 100, 300], pricePerLevel: 10 },
  expansion: {
    bag: { step: 5, currencyId: "gold", costBase: 100, costIncrement: 50, initial: 10, max: 30 },
    storage: { step: 10, currencyId: "gold", costBase: 200, costIncrement: 0, initial: 10, max: 100 },
  },
});

function rosterSetup() {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  const store = new InMemoryRequestResultStore();
  const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(store);
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "gold" }]), new FixedClock(0));
  const activity: string[] = [];
  const roster = new RosterService(
    characters, new RosterCache(noCache), ledger, new MonsterProgression(progressionRules), () => ({ bagCapacity: 10, storageCapacity: 10 }), uow,
    { record: async (_user: string, kind: string) => { activity.push(kind); } }, undefined, { int: () => 0, float: () => 0 },
    { rules: rosterRules }, new Idempotency(store, uow),
  );
  return { wallets, characters, roster, store, activity };
}

describe("Roster requests with a request id", () => {
  it("power-up with a repeated id charges once, consumes the fodders once and answers the first response", async () => {
    const { wallets, characters, roster, activity } = rosterSetup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1" });
    characters.add(USER, { uid: "F1", characterId: "c1" });
    characters.add(USER, { uid: "F2", characterId: "c1" });

    const first = await roster.powerUp(USER, "T", ["F1", "F2"], "pu-1");
    assert.equal(first.priceSpent, 200);
    assert.equal(wallets.amount(USER, "gold"), 800);

    const again = await roster.powerUp(USER, "T", ["F1", "F2"], "pu-1");
    assert.deepEqual(again, { ...first, replayed: true });
    assert.equal(wallets.amount(USER, "gold"), 800, "not charged again");
    assert.equal(activity.filter((kind) => kind === "monster_powerup").length, 1, "activity recorded once");

    // Without the id the same retry fails: the fodders are gone.
    await assert.rejects(roster.powerUp(USER, "T", ["F1", "F2"]), (error: unknown) => error instanceof AppError && error.errorCode === "ROSTER_FODDER_NOT_FOUND");
  });

  it("a failed power-up leaves the id free for the corrected retry", async () => {
    const { wallets, characters, roster } = rosterSetup();
    wallets.set(USER, "gold", 0);
    characters.add(USER, { uid: "T", characterId: "c1" });
    characters.add(USER, { uid: "F", characterId: "c1" });
    await assert.rejects(roster.powerUp(USER, "T", ["F"], "pu-2"), (error: unknown) => error instanceof AppError);
    wallets.set(USER, "gold", 500);
    const ok = await roster.powerUp(USER, "T", ["F"], "pu-2");
    assert.equal(ok.replayed, undefined);
    assert.equal(characters.records.has("F"), false);
  });

  it("evolve, sell and expand replay too", async () => {
    const { wallets, characters, roster } = rosterSetup();
    wallets.set(USER, "gold", 10_000);
    characters.add(USER, { uid: "T", characterId: "c1" });
    characters.add(USER, { uid: "F1", characterId: "c1" });
    characters.add(USER, { uid: "F2", characterId: "c1" });
    const evolved = await roster.evolve(USER, "T", ["F1", "F2"], "ev-1");
    assert.equal(evolved.newStars, 2);
    const gold = wallets.amount(USER, "gold");
    assert.deepEqual(await roster.evolve(USER, "T", ["F1", "F2"], "ev-1"), { ...evolved, replayed: true });
    assert.equal(wallets.amount(USER, "gold"), gold);

    characters.add(USER, { uid: "S", characterId: "c1", stars: 2, level: 5 });
    const sold = await roster.sell(USER, ["S"], "sell-1");
    const afterSell = wallets.amount(USER, "gold");
    assert.deepEqual(await roster.sell(USER, ["S"], "sell-1"), { ...sold, replayed: true });
    assert.equal(wallets.amount(USER, "gold"), afterSell, "the sale is not paid twice");

    const expanded = await roster.expand(USER, "BAG", "ex-1");
    const afterExpand = wallets.amount(USER, "gold");
    assert.deepEqual(await roster.expand(USER, "BAG", "ex-1"), { ...expanded, replayed: true });
    assert.equal(wallets.amount(USER, "gold"), afterExpand, "the slots are not bought twice");
    const next = await roster.expand(USER, "BAG", "ex-2");
    assert.ok(next.bagCapacity > expanded.bagCapacity, "a new id is a new purchase");
  });
});

const roster: Record<string, { element: string; naturalStars: number }> = { imp_fire: { element: "fire", naturalStars: 3 } };
const characterRules = { get: (id: string) => (roster[id] ? ({ id, skillIds: ["s1"], ...roster[id] } as unknown as CharacterDTO) : undefined) };
const mystic: SummonScroll = {
  id: "mystic_scroll",
  currencyId: "scroll_cur",
  costPerSummon: 1,
  tenPlusOneCost: 10,
  pools: [{ id: "nat3", weight: 1, minStars: 3, maxStars: 3, entries: [{ characterId: "imp_fire", weight: 1 }] }],
};

describe("Summon with a request id", () => {
  /** `isolated: false` = a unit of work without rollback, so concurrent transactions do not restore each other's state. */
  function summonSetup(isolated = true) {
    const wallets = new InMemoryWalletRepository();
    const characters = new InMemoryCharacterRepository();
    characters.capacity = { bagCapacity: 100, storageCapacity: 0 };
    const store = new InMemoryRequestResultStore();
    const uow: UnitOfWork = isolated ? new InMemoryUnitOfWork().register(wallets).register(characters).register(store) : { transaction: (work) => work(SESSION) };
    const currencies = currencyRulesOf([{ id: "scroll_cur" }]);
    const clock = new FixedClock(Date.UTC(2026, 9, 15));
    const ledger = new WalletLedger(wallets, currencies, clock);
    const progression = new MonsterProgression({
      starTiers: () => [3].map((stars) => ({ stars, maxLevel: 40, expPerLevel: [] })),
      powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
      evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
    });
    const grants = new CharacterGrantService(characters, characterRules, progression, () => characters.capacity);
    const activity: Array<[string, number | undefined]> = [];
    const summons = new SummonService({ get: (id: string) => (id === mystic.id ? mystic : undefined) }, currencies, characterRules, grants, ledger, new RosterCache(noCache),
      createSeededRandom(7), uow, { record: async (_user: string, kind: string, amount?: number) => { activity.push([kind, amount]); } }, clock, null, new Idempotency(store, uow));
    return { wallets, characters, summons, activity };
  }

  it("a retry with the same id returns the same monsters and does not charge or grant again", async () => {
    const { wallets, characters, summons, activity } = summonSetup();
    wallets.set(USER, "scroll_cur", 30);
    const first = await summons.summon(USER, { scrollId: "mystic_scroll", multi: true, target: "BAG", requestId: "sm-1" });
    assert.equal(first.grants.length, 11);
    assert.equal(wallets.amount(USER, "scroll_cur"), 20);
    assert.equal(first.wallet.scroll_cur, 20, "the stored response carries the wallet of the first call");

    const retry = await summons.summon(USER, { scrollId: "mystic_scroll", multi: true, target: "BAG", requestId: "sm-1" });
    assert.deepEqual(retry, { ...first, replayed: true });
    assert.equal(wallets.amount(USER, "scroll_cur"), 20);
    assert.equal(characters.records.size, 11);
    assert.deepEqual(activity, [["summon", 11]]);

    const next = await summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG", requestId: "sm-2" });
    assert.notDeepEqual(next.grants.map((grant) => grant.uid), first.grants.map((grant) => grant.uid));
    assert.equal(wallets.amount(USER, "scroll_cur"), 19);
  });

  it("two simultaneous summons with the same id only charge once", async () => {
    const { wallets, characters, summons } = summonSetup(false);
    wallets.set(USER, "scroll_cur", 5);
    const [a, b] = await Promise.all([
      summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG", requestId: "race" }),
      summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG", requestId: "race" }),
    ]);
    assert.equal(wallets.amount(USER, "scroll_cur"), 4);
    assert.equal(characters.records.size, 1);
    assert.deepEqual(a.grants, b.grants);
  });

  it("a failed summon (not enough scrolls) is not stored", async () => {
    const { wallets, summons } = summonSetup();
    await assert.rejects(summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG", requestId: "sm-3" }), (error: unknown) => error instanceof AppError && error.errorCode === "NOT_ENOUGH_SCROLLS");
    wallets.set(USER, "scroll_cur", 1);
    const ok = await summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG", requestId: "sm-3" });
    assert.equal(ok.grants.length, 1);
    assert.equal(ok.replayed, undefined);
  });
});

describe("Awaken with a request id", () => {
  const hero = {
    id: "hero",
    naturalStars: 3,
    skillIds: ["s1"],
    awakenings: [{ minLevel: 10, minStars: 3, costs: [{ currencyId: "essence", amount: 5 }] }],
  } as unknown as CharacterDTO;

  function awakenSetup() {
    const wallets = new InMemoryWalletRepository();
    const characters = new InMemoryCharacterRepository();
    const store = new InMemoryRequestResultStore();
    const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(store);
    const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "essence" }]), new FixedClock(0));
    const activity: string[] = [];
    const awakening = new AwakeningService(characters, { get: (id: string) => (id === "hero" ? hero : undefined) }, ledger, new RosterCache(noCache), uow,
      { record: async (_user: string, kind: string) => { activity.push(kind); } }, new Idempotency(store, uow));
    characters.add(USER, { uid: "H", characterId: "hero", stars: 3, level: 10 });
    wallets.set(USER, "essence", 12);
    return { wallets, characters, awakening, activity, store };
  }

  it("a retry returns the first awakening instead of failing with NO_MORE_AWAKENINGS", async () => {
    const { wallets, characters, awakening, activity } = awakenSetup();
    const first = await awakening.awaken(USER, "H", false, "aw-1");
    assert.equal(first.ok, true);
    assert.equal(wallets.amount(USER, "essence"), 7);

    const retry = await awakening.awaken(USER, "H", false, "aw-1");
    assert.deepEqual(retry, { ...first, replayed: true });
    assert.equal(wallets.amount(USER, "essence"), 7);
    assert.equal(characters.records.get("H")!.awakeningIndex, 1);
    assert.equal(activity.filter((kind) => kind === "monster_awaken").length, 1);

    await assert.rejects(awakening.awaken(USER, "H", false, "aw-2"), (error: unknown) => error instanceof AppError && error.errorCode === "NO_MORE_AWAKENINGS");
  });

  it("previews ignore the request id and store nothing", async () => {
    const { awakening, store } = awakenSetup();
    const preview = await awakening.awaken(USER, "H", true, "aw-3");
    assert.equal((preview as { preview?: boolean }).preview, true);
    assert.equal(store.rows.size, 0);
    assert.equal((await awakening.awaken(USER, "H", false, "aw-3")).ok, true, "the id is still free for the real awakening");
  });
});

describe("Stage start with a request id", () => {
  const floor = (id: string): MapStage => ({
    id,
    scene: "Region_Test",
    currencyId: "energy",
    costs: [{ difficulty: "Easy", amount: 3 }, { difficulty: "Normal", amount: 3 }, { difficulty: "Hard", amount: 3 }, { difficulty: "Hell", amount: 3 }],
    formation: { front: 2, back: 2, leaderIndex: 0 },
  });
  const catalog: MapCatalog = { regions: [{ id: "r1", kind: "story", stageCount: 1, stages: [floor("s1")] }] };
  const request = { regionId: "r1", stageId: "s1", difficulty: "Easy" as const, uidsInSlots: ["U1"], leaderSlotIndex: 0 };

  function stageSetup() {
    const wallets = new InMemoryWalletRepository();
    const characters = new InMemoryCharacterRepository();
    const battles = new InMemoryPveBattleRepository();
    const progress = new InMemoryMapProgressRepository();
    const store = new InMemoryRequestResultStore();
    const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(battles).register(progress).register(store);
    const clock = new FixedClock(Date.UTC(2026, 9, 13, 12));
    const currencies = currencyRulesOf([{ id: "energy" }]);
    const ledger = new WalletLedger(wallets, currencies, clock);
    const economy = new EconomyService(wallets, ledger, currencies, uow, clock);
    const maps = { catalog: () => catalog, getStage: (r: string, s: string) => catalog.regions.find((x) => x.id === r)?.stages.find((x) => x.id === s) };
    const activity: string[] = [];
    const service = new MapService(progress, maps, characters, ledger, economy, battles, uow, undefined,
      { record: async (_user: string, kind: string) => { activity.push(kind); } }, new Idempotency(store, uow));
    characters.add(USER, { uid: "U1", characterId: "c1", stars: 2, level: 1 });
    wallets.set(USER, "energy", 30);
    return { service, wallets, activity };
  }

  it("a retry returns the same ticket and does not spend the energy again", async () => {
    const { service, wallets, activity } = stageSetup();
    const first = await service.validateStageStart(USER, { ...request, requestId: "st-1" });
    assert.equal(wallets.amount(USER, "energy"), 27);
    assert.equal(first.wallet.energy, 27);

    const retry = await service.validateStageStart(USER, { ...request, requestId: "st-1" });
    assert.deepEqual(retry, { ...first, replayed: true });
    assert.equal(retry.ticketId, first.ticketId);
    assert.equal(wallets.amount(USER, "energy"), 27);
    assert.deepEqual(activity, ["energy_spent"]);

    const other = await service.validateStageStart(USER, { ...request, requestId: "st-2" });
    assert.notEqual(other.ticketId, first.ticketId);
    assert.equal(wallets.amount(USER, "energy"), 24);
  });

  it("not enough energy is not stored", async () => {
    const { service, wallets } = stageSetup();
    wallets.set(USER, "energy", 1);
    await assert.rejects(service.validateStageStart(USER, { ...request, requestId: "st-3" }), (error: unknown) => error instanceof AppError && error.errorCode === "INSUFFICIENT_FUNDS");
    wallets.set(USER, "energy", 30);
    assert.equal((await service.validateStageStart(USER, { ...request, requestId: "st-3" })).replayed, undefined);
  });
});
