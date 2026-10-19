import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { AppError } from "../src/shared/errors/app-error";
import type { HomeBuildableCfg, HomeCatalog } from "../src/config/HomeCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { HomeService } from "../src/modules/home/home.service";
import { noCache } from "../src/shared/kernel/cache";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { currencyRulesOf, homeRulesOf, InMemoryBuildingInventory, InMemoryCharacterRepository, InMemoryHomeProductionRepository, InMemoryHomeRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";

const buildable = (id: string, extra: Partial<HomeBuildableCfg> = {}): HomeBuildableCfg => ({
  id, displayName: id, kind: "Building", canPurchase: true, canSpawnAsIslandDefault: true, canMove: true, canRemove: true,
  isUnique: false, countsTowardsLimit: true, maxCount: 0, unlockLevel: 0, placeCostCurrencyId: "gold", placeCostAmount: 100,
  removeCostAmount: 0, rotationStepDegrees: 90, footprints: [{ rotationIndex: 0, yawDegrees: 0, cells: [{ x: 0, z: 0 }] }],
  ...extra,
});

const catalog: HomeCatalog = {
  version: "1", generatedAtUnix: 0, defaultIslandId: "main",
  buildables: [
    buildable("hut"),
    buildable("statue", { canPurchase: false, isUnique: true }),
  ],
  islands: [{
    id: "main", displayName: "main", unlockedByDefault: true, unlockLevel: 0, unlockCostAmount: 0, order: 0,
    gridSizeX: 3, gridSizeZ: 1, cellSize: 1,
    cells: [0, 1, 2].map((x) => ({ x, z: 0, flags: 1 })), defaultPlacements: [],
  }],
};

function setup(homeCatalog: HomeCatalog = catalog, level = 1) {
  const wallets = new InMemoryWalletRepository();
  const homeRepo = new InMemoryHomeRepository();
  const inventory = new InMemoryBuildingInventory();
  const productions = new InMemoryHomeProductionRepository();
  const characters = new InMemoryCharacterRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(homeRepo).register(inventory).register(productions);
  const clock = new FixedClock(Date.UTC(2026, 9, 7));
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "gold" }]), clock);
  const progression = new MonsterProgression({
    starTiers: () => [{ stars: 2, maxLevel: 5, expPerLevel: [100, 100, 100, 100] }],
    powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
  });
  const homes = new HomeService(homeRepo, inventory, homeRulesOf(homeCatalog), ledger, async () => level, uow, clock, productions, characters, progression, new RosterCache(noCache));
  return { wallets, inventory, homes, homeRepo, productions, characters, clock };
}

const place = (x: number, id = "hut") => ({ islandId: "main", definitionId: id, originX: x, originZ: 0, yawDegrees: 0 });
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

describe("HomeService building inventory", () => {
  it("places from the inventory instead of charging the build cost, then charges once it is empty", async () => {
    const { wallets, inventory, homes } = setup();
    wallets.set(USER, "gold", 100);
    await homes.grant(USER, "hut", 1, { kind: "db-session" });

    const first = await homes.placeObject(USER, place(0));
    assert.equal(wallets.amount(USER, "gold"), 100);
    assert.equal(inventory.amount(USER, "hut"), 0);
    assert.deepEqual(first.snapshot?.inventory, []);
    assert.equal(first.snapshot?.islands[0].placements.length, 1);

    await homes.placeObject(USER, place(1));
    assert.equal(wallets.amount(USER, "gold"), 0);
    await assert.rejects(homes.placeObject(USER, place(2)), isError("ECON_INSUFFICIENT_FUNDS"));
  });

  it("keeps validating the placement and does not consume the inventory when it fails", async () => {
    const { wallets, inventory, homes } = setup();
    await homes.grant(USER, "hut", 2, { kind: "db-session" });

    await assert.rejects(homes.placeObject(USER, place(5)), isError("HOME_OUT_OF_BOUNDS"));
    assert.equal(inventory.amount(USER, "hut"), 2);
    await homes.placeObject(USER, place(0));
    await assert.rejects(homes.placeObject(USER, place(0)), isError("HOME_OVERLAP"));
    assert.equal(inventory.amount(USER, "hut"), 1);
    assert.equal(wallets.amount(USER, "gold"), 0);
  });

  it("lets non-purchasable buildings be placed only from the inventory and keeps the unique limit", async () => {
    const { inventory, homes } = setup();
    await assert.rejects(homes.placeObject(USER, place(0, "statue")), isError("HOME_NOT_PURCHASABLE"));

    await homes.grant(USER, "statue", 2, { kind: "db-session" });
    await homes.placeObject(USER, place(0, "statue"));
    await assert.rejects(homes.placeObject(USER, place(1, "statue")), isError("HOME_LIMIT_REACHED"));
    assert.equal(inventory.amount(USER, "statue"), 1);
  });

  it("rejects grants of buildings missing from the catalog and scopes the stock per user", async () => {
    const { inventory, homes } = setup();
    await assert.rejects(homes.grant(USER, "nope", 1, { kind: "db-session" }), isError("HOME_DEFINITION_NOT_FOUND"));
    await homes.grant(USER, "hut", 1, { kind: "db-session" });
    assert.deepEqual((await homes.getSnapshot("user-2")).inventory, []);
    assert.equal(inventory.amount("user-2", "hut"), 0);
  });
});

describe("HomeService remove cost", () => {
  // Mirrored by the Unity offline backend (OfflineHomeService.Remove / TrySpendCost): same order and error codes.
  const removeCatalog: HomeCatalog = {
    ...catalog,
    buildables: [
      buildable("hut", { removeCostCurrencyId: "gold", removeCostAmount: 30 }),
      buildable("rock", { canPurchase: false, removeCostCurrencyId: "gold", removeCostAmount: 50 }),
      buildable("statue", { canRemove: false, removeCostCurrencyId: "gold", removeCostAmount: 5 }),
      buildable("bush", { removeCostCurrencyId: "  ", removeCostAmount: 10 }),
    ],
    islands: [{
      ...catalog.islands[0],
      defaultPlacements: [{ templateInstanceId: "rock-1", buildableId: "rock", x: 2, z: 0, yawDegrees: 0 }],
    }],
  };

  /** Places `id` from the inventory (no place cost) and returns its instance id. */
  async function placeFree(homes: HomeService, id: string, x: number): Promise<string> {
    await homes.grant(USER, id, 1, { kind: "db-session" });
    const placed = await homes.placeObject(USER, place(x, id));
    const placement = placed.snapshot!.islands[0].placements.find((p) => !p.isTemplateObject && p.buildableId === id && p.x === x);
    assert.ok(placement);
    return placement.instanceId;
  }

  const placementsOf = (snapshot: { islands: Array<{ placements: Array<{ instanceId: string }> }> } | undefined) =>
    (snapshot?.islands[0].placements ?? []).map((p) => p.instanceId);

  it("debits removeCost when a placed object is removed and returns the full wallet", async () => {
    const { wallets, homes } = setup(removeCatalog);
    wallets.set(USER, "gold", 100);
    const instanceId = await placeFree(homes, "hut", 0);

    const removed = await homes.removeObject(USER, { islandId: "main", instanceId });
    assert.equal(wallets.amount(USER, "gold"), 70);
    assert.equal(removed.wallet?.gold, 70);
    assert.ok(!placementsOf(removed.snapshot).includes(instanceId));
  });

  it("rejects the removal without funds and keeps the object and the wallet", async () => {
    const { wallets, homes } = setup(removeCatalog);
    wallets.set(USER, "gold", 29);
    const instanceId = await placeFree(homes, "hut", 0);

    await assert.rejects(homes.removeObject(USER, { islandId: "main", instanceId }), isError("ECON_INSUFFICIENT_FUNDS"));
    assert.equal(wallets.amount(USER, "gold"), 29);
    assert.ok(placementsOf(await homes.getSnapshot(USER)).includes(instanceId));
  });

  it("charges island template objects too and records them as removed", async () => {
    const { wallets, homes } = setup(removeCatalog);
    wallets.set(USER, "gold", 60);

    const removed = await homes.removeObject(USER, { islandId: "main", instanceId: "rock-1" });
    assert.equal(wallets.amount(USER, "gold"), 10);
    assert.deepEqual(removed.snapshot?.islands[0].removedTemplateInstanceIds, ["rock-1"]);
    assert.ok(!placementsOf(removed.snapshot).includes("rock-1"));
  });

  it("checks canRemove before charging", async () => {
    const { wallets, homes } = setup(removeCatalog);
    wallets.set(USER, "gold", 100);
    const instanceId = await placeFree(homes, "statue", 0);

    await assert.rejects(homes.removeObject(USER, { islandId: "main", instanceId }), isError("HOME_NOT_REMOVABLE"));
    assert.equal(wallets.amount(USER, "gold"), 100);
  });

  it("treats a missing or blank currency id and a zero amount as free", async () => {
    const { wallets, homes } = setup(removeCatalog);
    wallets.set(USER, "gold", 0);
    const bush = await placeFree(homes, "bush", 0);
    await homes.removeObject(USER, { islandId: "main", instanceId: bush });
    assert.equal(wallets.amount(USER, "gold"), 0);

    const { wallets: wallets2, homes: homes2 } = setup();
    wallets2.set(USER, "gold", 0);
    const hut = await placeFree(homes2, "hut", 0);
    const removed = await homes2.removeObject(USER, { islandId: "main", instanceId: hut });
    assert.equal(removed.wallet?.gold, 0);
    assert.ok(!placementsOf(removed.snapshot).includes(hut));
  });
});

describe("HomeService island purchases", () => {
  // Mirrored by the Unity offline backend (OfflineHomeService.UnlockIsland): same order and error codes.
  const islandsCatalog: HomeCatalog = {
    ...catalog,
    islands: [
      catalog.islands[0],
      {
        ...catalog.islands[0], id: "east", displayName: "east", unlockedByDefault: false, order: 1,
        unlockLevel: 5, unlockCostCurrencyId: "gold", unlockCostAmount: 500,
      },
      { ...catalog.islands[0], id: "gift", displayName: "gift", unlockedByDefault: false, order: 2, unlockCostAmount: 0 },
    ],
  };
  const placeOn = (islandId: string) => ({ islandId, definitionId: "hut", originX: 0, originZ: 0, yawDegrees: 0 });

  it("starts with the default island only and refuses placements on locked islands", async () => {
    const { wallets, homes } = setup(islandsCatalog, 10);
    wallets.set(USER, "gold", 1000);
    const snapshot = await homes.getSnapshot(USER);
    assert.deepEqual(snapshot.islands.map((i) => [i.islandId, i.unlocked]), [["main", true], ["east", false], ["gift", false]]);
    await assert.rejects(homes.placeObject(USER, placeOn("east")), isError("HOME_ISLAND_LOCKED"));
    assert.equal(wallets.amount(USER, "gold"), 1000);
  });

  it("checks the level, then charges the price and unlocks the island for building", async () => {
    const low = setup(islandsCatalog, 4);
    low.wallets.set(USER, "gold", 1000);
    await assert.rejects(low.homes.unlockIsland(USER, "east"), isError("HOME_LOCKED"));
    assert.equal(low.wallets.amount(USER, "gold"), 1000);

    const { wallets, homes } = setup(islandsCatalog, 5);
    wallets.set(USER, "gold", 499);
    await assert.rejects(homes.unlockIsland(USER, "east"), isError("ECON_INSUFFICIENT_FUNDS"));
    assert.equal((await homes.getSnapshot(USER)).islands[1].unlocked, false);

    wallets.set(USER, "gold", 600);
    const bought = await homes.unlockIsland(USER, "east");
    assert.equal(wallets.amount(USER, "gold"), 100);
    assert.equal(bought.wallet?.gold, 100);
    assert.equal(bought.snapshot?.selectedIslandId, "east");
    assert.equal(bought.snapshot?.islands.find((i) => i.islandId === "east")?.unlocked, true);

    const placed = await homes.placeObject(USER, placeOn("east"));
    assert.equal(placed.snapshot?.islands.find((i) => i.islandId === "east")?.placements.length, 1);
  });

  it("refuses buying twice, default islands and unknown islands; free islands cost nothing", async () => {
    const { wallets, homes } = setup(islandsCatalog, 10);
    wallets.set(USER, "gold", 0);
    await homes.unlockIsland(USER, "gift");
    await assert.rejects(homes.unlockIsland(USER, "gift"), isError("HOME_ISLAND_ALREADY_UNLOCKED"));
    await assert.rejects(homes.unlockIsland(USER, "main"), isError("HOME_ISLAND_ALREADY_UNLOCKED"));
    await assert.rejects(homes.unlockIsland(USER, "nope"), isError("HOME_ISLAND_NOT_FOUND"));
    assert.equal(wallets.amount(USER, "gold"), 0);
    assert.equal((await homes.getSnapshot("user-2")).islands.find((i) => i.islandId === "gift")?.unlocked, false);
  });
});
