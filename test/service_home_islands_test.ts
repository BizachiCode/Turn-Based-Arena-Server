import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { AppError } from "../src/shared/errors/app-error";
import type { HomeBuildableCfg, HomeCatalog, HomeIslandCfg } from "../src/config/HomeCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { HomeMessageSchema } from "../src/modules/home/home.validation";
import { HomeService } from "../src/modules/home/home.service";
import { noCache } from "../src/shared/kernel/cache";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { currencyRulesOf, homeRulesOf, InMemoryBuildingInventory, InMemoryCharacterRepository, InMemoryHomeProductionRepository, InMemoryHomeRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

/*
 * Island expansions (`unlock_island`), the rules the Unity client relies on for the unlock popup, the Home markers and
 * the shop's island cards. The Unity offline backend (`OfflineHomeService.UnlockIsland`) mirrors the same order and codes.
 */

const USER = "user-1";
const OTHER = "user-2";

const hut: HomeBuildableCfg = {
  id: "hut", displayName: "hut", kind: "Building", canPurchase: true, canSpawnAsIslandDefault: true, canMove: true, canRemove: true,
  isUnique: false, countsTowardsLimit: false, maxCount: 0, unlockLevel: 0, placeCostCurrencyId: "GO", placeCostAmount: 0,
  removeCostAmount: 0, rotationStepDegrees: 90, footprints: [{ rotationIndex: 0, yawDegrees: 0, cells: [{ x: 0, z: 0 }] }],
};

const island = (id: string, extra: Partial<HomeIslandCfg> = {}): HomeIslandCfg => ({
  id, displayName: id, unlockedByDefault: false, unlockLevel: 0, unlockCostAmount: 0, order: 0,
  gridSizeX: 2, gridSizeZ: 1, cellSize: 1, cells: [0, 1].map((x) => ({ x, z: 0, flags: 1 })), defaultPlacements: [],
  ...extra,
});

// Same shape as the shipped homes.json: island_east needs level 3 and 30,000 Lunar Stone (GO).
const catalog: HomeCatalog = {
  version: "1", generatedAtUnix: 0, defaultIslandId: "main_island",
  buildables: [hut],
  islands: [
    island("main_island", { unlockedByDefault: true }),
    island("island_east", { order: 1, unlockLevel: 3, unlockCostCurrencyId: "GO", unlockCostAmount: 30_000 }),
    island("island_north", { order: 2, unlockLevel: 6, unlockCostCurrencyId: "GO", unlockCostAmount: 80_000 }),
    island("island_free", { order: 3, unlockCostCurrencyId: "GO", unlockCostAmount: 0 }),
    island("island_blank", { order: 4, unlockCostCurrencyId: "  ", unlockCostAmount: 500 }),
  ],
};

function setup(level = 3, homeRepo = new InMemoryHomeRepository()) {
  const wallets = new InMemoryWalletRepository();
  const inventory = new InMemoryBuildingInventory();
  const productions = new InMemoryHomeProductionRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(homeRepo).register(inventory).register(productions);
  const clock = new FixedClock(Date.UTC(2026, 9, 15));
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "GO" }]), clock);
  const progression = new MonsterProgression({
    starTiers: () => [{ stars: 2, maxLevel: 5, expPerLevel: [100, 100, 100, 100] }],
    powerUp: () => ({ currencyId: "GO", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "GO", costPerStarUnit: 0, steps: [] }),
  });
  const levels = { value: level };
  const homes = new HomeService(homeRepo, inventory, homeRulesOf(catalog), ledger, async () => levels.value, uow, clock, productions,
    new InMemoryCharacterRepository(), progression, new RosterCache(noCache));
  return { wallets, homes, homeRepo, levels };
}

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
const unlockedOf = async (homes: HomeService, userId = USER) =>
  (await homes.getSnapshot(userId)).islands.filter((entry) => entry.unlocked).map((entry) => entry.islandId);

describe("HomeService island unlock: level requirement", () => {
  it("refuses below unlockLevel with HOME_LOCKED, charges nothing and records nothing", async () => {
    const { wallets, homes, homeRepo } = setup(2);
    wallets.set(USER, "GO", 50_000);
    await assert.rejects(homes.unlockIsland(USER, "island_east"), isError("HOME_LOCKED"));
    assert.equal(wallets.amount(USER, "GO"), 50_000);
    assert.deepEqual(await unlockedOf(homes), ["main_island"]);
    assert.equal((await homeRepo.getPrefs(USER)).revision, 0);
  });

  it("accepts exactly at unlockLevel and checks the level before the price", async () => {
    const { wallets, homes, levels } = setup(5);
    wallets.set(USER, "GO", 0);
    // level 5 < 6: the level error wins even without funds
    await assert.rejects(homes.unlockIsland(USER, "island_north"), isError("HOME_LOCKED"));
    levels.value = 6;
    await assert.rejects(homes.unlockIsland(USER, "island_north"), isError("ECON_INSUFFICIENT_FUNDS"));
    wallets.set(USER, "GO", 80_000);
    await homes.unlockIsland(USER, "island_north");
    assert.ok((await unlockedOf(homes)).includes("island_north"));
  });
});

describe("HomeService island unlock: cost", () => {
  it("debits the exact price, answers with the full wallet, selects the island and bumps the revision once", async () => {
    const { wallets, homes } = setup(3);
    wallets.set(USER, "GO", 30_250);
    const before = (await homes.getSnapshot(USER)).revision;

    const bought = await homes.unlockIsland(USER, "island_east");

    assert.equal(bought.ok, true);
    assert.equal(wallets.amount(USER, "GO"), 250);
    assert.equal(bought.wallet?.GO, 250);
    assert.equal(bought.snapshot?.selectedIslandId, "island_east");
    assert.equal(bought.snapshot?.revision, before + 1);
    assert.equal(bought.snapshot?.islands.find((entry) => entry.islandId === "island_east")?.unlocked, true);
  });

  it("rolls everything back without funds, then a retry with funds charges once", async () => {
    const { wallets, homes, homeRepo } = setup(3);
    wallets.set(USER, "GO", 29_999);
    await assert.rejects(homes.unlockIsland(USER, "island_east"), isError("ECON_INSUFFICIENT_FUNDS"));
    assert.equal(wallets.amount(USER, "GO"), 29_999);
    assert.deepEqual(await unlockedOf(homes), ["main_island"]);
    assert.equal(homeRepo.unlocked.size, 0, "the ownership claim is rolled back with the failed debit");

    wallets.set(USER, "GO", 30_000);
    await homes.unlockIsland(USER, "island_east");
    assert.equal(wallets.amount(USER, "GO"), 0);
  });

  it("treats amount 0 and a blank currency id as free", async () => {
    const { wallets, homes } = setup(1);
    wallets.set(USER, "GO", 0);
    await homes.unlockIsland(USER, "island_free");
    await homes.unlockIsland(USER, "island_blank");
    assert.equal(wallets.amount(USER, "GO"), 0);
    assert.deepEqual(await unlockedOf(homes), ["main_island", "island_free", "island_blank"]);
  });
});

describe("HomeService island unlock: idempotency and ownership", () => {
  it("answers HOME_ISLAND_ALREADY_UNLOCKED to a repeated purchase and never charges twice", async () => {
    const { wallets, homes } = setup(3);
    wallets.set(USER, "GO", 100_000);
    await homes.unlockIsland(USER, "island_east");
    await assert.rejects(homes.unlockIsland(USER, "island_east"), isError("HOME_ISLAND_ALREADY_UNLOCKED"));
    await assert.rejects(homes.unlockIsland(USER, "island_east"), isError("HOME_ISLAND_ALREADY_UNLOCKED"));
    assert.equal(wallets.amount(USER, "GO"), 70_000);
  });

  it("lets the ownership claim decide a race the first read missed (no second debit)", async () => {
    // A concurrent purchase committed between this request's read and its claim: the read is stale, the claim is not.
    class StaleReadRepository extends InMemoryHomeRepository {
      override async listUnlockedIslands(): Promise<string[]> { return []; }
    }
    const repo = new StaleReadRepository();
    repo.unlocked.add(`${USER}|island_east`);
    const { wallets, homes } = setup(3, repo);
    wallets.set(USER, "GO", 100_000);

    await assert.rejects(homes.unlockIsland(USER, "island_east"), isError("HOME_ISLAND_ALREADY_UNLOCKED"));
    assert.equal(wallets.amount(USER, "GO"), 100_000);
  });

  it("refuses default islands and unknown islands", async () => {
    const { wallets, homes } = setup(99);
    wallets.set(USER, "GO", 100_000);
    await assert.rejects(homes.unlockIsland(USER, "main_island"), isError("HOME_ISLAND_ALREADY_UNLOCKED"));
    await assert.rejects(homes.unlockIsland(USER, "island_nowhere"), isError("HOME_ISLAND_NOT_FOUND"));
    assert.equal(wallets.amount(USER, "GO"), 100_000);
  });

  it("scopes ownership per player and opens the island for building only for its owner", async () => {
    const { wallets, homes } = setup(3);
    wallets.set(USER, "GO", 30_000);
    await homes.unlockIsland(USER, "island_east");

    const place = { islandId: "island_east", definitionId: "hut", originX: 0, originZ: 0, yawDegrees: 0 };
    const placed = await homes.placeObject(USER, place);
    assert.equal(placed.snapshot?.islands.find((entry) => entry.islandId === "island_east")?.placements.length, 1);

    assert.deepEqual(await unlockedOf(homes, OTHER), ["main_island"]);
    await assert.rejects(homes.placeObject(OTHER, place), isError("HOME_ISLAND_LOCKED"));
  });
});

describe("Home unlock_island message", () => {
  const parse = (payload: unknown) => HomeMessageSchema.safeParse(payload);

  it("accepts { type, islandId } only", () => {
    assert.equal(parse({ type: "unlock_island", islandId: "island_east" }).success, true);
    assert.equal(parse({ type: "unlock_island" }).success, false);
    assert.equal(parse({ type: "unlock_island", islandId: "" }).success, false);
    assert.equal(parse({ type: "unlock_island", islandId: "x".repeat(81) }).success, false);
    // the client never chooses the price or the player
    assert.equal(parse({ type: "unlock_island", islandId: "island_east", userId: "someone" }).success, false);
    assert.equal(parse({ type: "unlock_island", islandId: "island_east", unlockCostAmount: 0 }).success, false);
  });
});
