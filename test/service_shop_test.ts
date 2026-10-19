import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { noAudit } from "../src/shared/kernel/audit";
import { AppError } from "../src/shared/errors/app-error";
import { parseShopCatalog, type ShopCatalog } from "../src/config/ShopCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { CharacterGrantService } from "../src/modules/roster/character-grant.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneService } from "../src/modules/rune/rune.service";
import { isAvailable, priceFor, windowKeyFor } from "../src/modules/shop/shop.domain";
import type { ShopCounter, ShopRepository } from "../src/modules/shop/shop.ports";
import { ShopService } from "../src/modules/shop/shop.service";
import { HomeService } from "../src/modules/home/home.service";
import type { HomeCatalog } from "../src/config/HomeCatalog";
import type { IapReceiptValidator, IapStoreVerifier } from "../src/modules/shop/iap/iap.ports";
import { StoreIapReceiptValidator } from "../src/modules/shop/iap/iap-receipt-validator";
import { iapAccountToken, iapTransactionKey } from "../src/modules/shop/iap/iap.domain";
import { currencyRulesOf, homeRulesOf, InMemoryBuildingInventory, InMemoryIapTransactionRepository, InMemoryCharacterRepository, InMemoryHomeProductionRepository, InMemoryHomeRepository, InMemoryMapProgressRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";
const NOW = Date.UTC(2026, 9, 7, 10, 0, 0); // Wednesday

const catalog: ShopCatalog = parseShopCatalog(JSON.stringify({
  ActiveRotationTags: ["week-a"],
  Items: [
    {
      ItemId: "daily_gold", ItemType: 0,
      BasePrices: [{ Kind: 1, CurrencyId: "gem", Amount: 10 }],
      ProgressiveTiers: [{ FromPurchaseIndex: 1, Price: { Kind: 1, CurrencyId: "gem", Amount: 20 } }],
      Discounts: [{ Mode: "PercentOff", PercentOff: 50, StartUtc: "2026-10-07T00:00:00Z", EndUtc: "2026-10-08T00:00:00Z" }],
      Limit: { Scope: "Daily", MaxPurchases: 2, GiveFirstPurchaseBonus: true, ResetHourUtc: 12 },
      Rewards: { Currencies: [{ CurrencyId: "gold", Amount: 1000 }] },
      FirstPurchaseBonus: { Currencies: [{ CurrencyId: "gold", Amount: 500 }] },
    },
    {
      itemId: "starter_hero", itemType: "Character",
      availability: { mode: "RotationTag", rotationTag: "week-a" },
      minAccountLevel: 1,
      basePrices: [{ kind: "SoftCurrency", currencyId: "gold", amount: 100 }],
      limit: { scope: "None", uniquePerAccount: true },
      rewards: { characters: [{ characterId: "hero", star: 4 }] },
    },
    { itemId: "open_start", availability: { mode: "DateRangeUtc", startUtc: "2026-10-01T00:00:00Z" }, basePrices: [{ kind: "SoftCurrency", currencyId: "gold", amount: 1 }] },
    { itemId: "open_end", availability: { mode: "DateRangeUtc", endUtc: "2026-10-05T00:00:00Z" }, basePrices: [{ kind: "SoftCurrency", currencyId: "gold", amount: 1 }] },
    { itemId: "gated", requiredProgressId: "Region_1:Stage_3:easy", basePrices: [{ kind: "SoftCurrency", currencyId: "gold", amount: 1 }] },
    { itemId: "gated_stage", requiredProgressId: "stage_3", basePrices: [{ kind: "SoftCurrency", currencyId: "gold", amount: 1 }] },
    { itemId: "iap_pack", basePrices: [{ kind: "RealMoneyIAP", iapProductId: "com.game.pack" }], rewards: { currencies: [{ currencyId: "gem", amount: 70 }] } },
    {
      itemId: "iap_starter", basePrices: [{ kind: "RealMoneyIAP", iapProductId: "com.game.starter" }],
      availability: { mode: "DateRangeUtc", endUtc: "2026-10-07T09:00:00Z" }, // ended an hour ago
      limit: { scope: "None", uniquePerAccount: true }, rewards: { currencies: [{ currencyId: "gem", amount: 500 }] },
    },
    { itemId: "ghost_house", rewards: { constructions: [{ buildableId: "missing_building" }] } },
    { itemId: "huts", basePrices: [{ kind: "SoftCurrency", currencyId: "gold", amount: 10 }], rewards: { constructions: [{ buildableId: "hut", count: 2 }] } },
    {
      itemId: "tower_pack", basePrices: [{ kind: "SoftCurrency", currencyId: "gold", amount: 50 }],
      rewards: { constructions: [{ buildableId: "tower", count: 3, forceUnique: true }] },
    },
  ],
  Iap: { DemoPurchases: true },
}));

const homeCatalog: HomeCatalog = {
  version: "1", generatedAtUnix: 0, defaultIslandId: "main",
  buildables: ["hut", "tower"].map((id) => ({
    id, displayName: id, kind: "Building", canPurchase: true, canSpawnAsIslandDefault: true, canMove: true, canRemove: true,
    isUnique: false, countsTowardsLimit: false, maxCount: 0, unlockLevel: 0, placeCostCurrencyId: "gold", placeCostAmount: 100,
    removeCostAmount: 0, rotationStepDegrees: 90, footprints: [{ rotationIndex: 0, yawDegrees: 0, cells: [{ x: 0, z: 0 }] }],
  })),
  islands: [{
    id: "main", displayName: "main", unlockedByDefault: true, unlockLevel: 0, unlockCostAmount: 0, order: 0, gridSizeX: 2, gridSizeZ: 2, cellSize: 1,
    cells: [0, 1].flatMap((x) => [0, 1].map((z) => ({ x, z, flags: 1 }))), defaultPlacements: [],
  }],
};

class InMemoryShopRepository implements ShopRepository {
  counters = new Map<string, number>();
  log: unknown[] = [];
  async listCounters(userId: string): Promise<ShopCounter[]> {
    return [...this.counters].filter(([key]) => key.startsWith(`${userId}|`)).map(([key, count]) => {
      const [, itemId, windowKey] = key.split("|");
      return { itemId, windowKey, count };
    });
  }
  async lockCounters(userId: string, itemId: string, keys: string[]): Promise<Map<string, number>> {
    return new Map(keys.map((key) => [key, this.counters.get(`${userId}|${itemId}|${key}`) ?? 0]));
  }
  async incrementCounter(userId: string, itemId: string, windowKey: string): Promise<void> {
    const key = `${userId}|${itemId}|${windowKey}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  async logPurchase(entry: { purchaseId: string | null; response: unknown }): Promise<void> {
    this.log.push(entry);
  }
  async findPurchaseResponse(_userId: string, purchaseId: string): Promise<unknown | null> {
    return (this.log as Array<{ purchaseId: string | null; response: unknown }>).find((entry) => entry.purchaseId === purchaseId)?.response ?? null;
  }
  snapshot(): unknown { return new Map(this.counters); }
  restore(state: unknown): void { this.counters = state as Map<string, number>; }
}

function setup(options: { iap?: IapReceiptValidator | null } = {}) {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  const shopRepo = new InMemoryShopRepository();
  const homeRepo = new InMemoryHomeRepository();
  const inventory = new InMemoryBuildingInventory();
  const iapTransactions = new InMemoryIapTransactionRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(shopRepo).register(homeRepo).register(inventory).register(iapTransactions);
  const clock = new FixedClock(NOW);
  const currencies = currencyRulesOf([{ id: "gem" }, { id: "gold" }]);
  const ledger = new WalletLedger(wallets, currencies, clock);
  const progression = new MonsterProgression({
    starTiers: () => [{ stars: 4, maxLevel: 40, expPerLevel: [] }],
    powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
  });
  const characterRules = { get: (id: string) => (id === "hero" ? ({ id: "hero", naturalStars: 3, skillIds: ["a"] } as any) : undefined) };
  const homes = new HomeService(homeRepo, inventory, homeRulesOf(homeCatalog), ledger, async () => 1, uow, clock, new InMemoryHomeProductionRepository(), characters, progression, new RosterCache(noCache));
  const progress = new InMemoryMapProgressRepository();
  const shop = new ShopService({
    shop: shopRepo,
    catalog: { catalog: () => catalog, get: (id) => catalog.items.find((item) => item.itemId === id) },
    ledger,
    characters,
    characterGrants: new CharacterGrantService(characters, characterRules, progression, () => characters.capacity),
    runes: { grantRunes: async () => [] } as unknown as RuneService,
    constructions: homes,
    progress,
    scrolls: { get: () => undefined },
    currencies,
    accountLevel: async () => 1,
    iap: options.iap ?? null,
    iapTransactions,
    rosterCache: new RosterCache(noCache),
    runeCache: new RuneCache(noCache),
    audit: noAudit,
    uow,
    clock,
  });
  return { wallets, characters, shopRepo, shop, inventory, homes, progress, iapTransactions };
}

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

describe("Shop domain", () => {
  const daily = catalog.items[0];

  it("computes UTC windows honouring the reset hour", () => {
    assert.equal(windowKeyFor(daily, new Date(NOW)), "D:2026-10-06"); // 10:00 < 12:00 reset
    assert.equal(windowKeyFor(daily, new Date(Date.UTC(2026, 9, 7, 12, 0, 0))), "D:2026-10-07");
    assert.equal(windowKeyFor({ ...daily, limit: { ...daily.limit, scope: "Weekly", weekStartsOn: 1, resetHourUtc: 0 } }, new Date(NOW)), "W:2026-10-05");
    assert.equal(windowKeyFor({ ...daily, limit: { ...daily.limit, scope: "Monthly" } }, new Date(NOW)), "M:2026-10");
    assert.equal(windowKeyFor(catalog.items[1], new Date(NOW)), "U");
  });

  it("treats an empty start or end of a date range as open-ended", () => {
    const at = (id: string, ms: number) => isAvailable(catalog.items.find((item) => item.itemId === id)!, new Date(ms), []);
    assert.equal(at("open_start", NOW), true);
    assert.equal(at("open_start", Date.UTC(2026, 8, 30)), false);
    assert.equal(at("open_end", NOW), false);
    assert.equal(at("open_end", Date.UTC(2026, 9, 4)), true);
  });

  it("applies progressive tiers then the best active discount", () => {
    assert.equal(priceFor(daily, 0, new Date(NOW)).amount, 5);
    assert.equal(priceFor(daily, 1, new Date(NOW)).amount, 10);
    assert.equal(priceFor(daily, 1, new Date(Date.UTC(2026, 9, 9))).amount, 20);
  });
});

describe("ShopService", () => {
  it("charges the server price, grants rewards + first purchase bonus and enforces the window limit", async () => {
    const { wallets, shop } = setup();
    wallets.set(USER, "gem", 100);

    await assert.rejects(shop.purchase(USER, { itemId: "daily_gold", expectedPrice: { currencyId: "gem", amount: 10 } }), (error: unknown) =>
      error instanceof AppError && error.errorCode === "PRICE_CHANGED" && (error.fields?.price as any).amount === 5);

    const first = await shop.purchase(USER, { itemId: "daily_gold", expectedPrice: { currencyId: "gem", amount: 5 } });
    assert.equal(first.priceSpent, 5);
    assert.equal(first.firstPurchaseBonusGranted, true);
    assert.deepEqual(first.grants.currencies, [{ currencyId: "gold", amount: 1500 }]);
    assert.deepEqual(first.counter, { itemId: "daily_gold", windowKey: "D:2026-10-06", count: 1 });

    const second = await shop.purchase(USER, { itemId: "daily_gold" });
    assert.equal(second.priceSpent, 10);
    assert.equal(second.firstPurchaseBonusGranted, false);
    await assert.rejects(shop.purchase(USER, { itemId: "daily_gold" }), isError("SHOP_LIMIT_REACHED"));
    assert.equal(wallets.amount(USER, "gem"), 85);
    assert.equal(wallets.amount(USER, "gold"), 2500);

    const state = await shop.getState(USER);
    assert.deepEqual(state.counters, [
      { itemId: "daily_gold", windowKey: "D:2026-10-06", count: 2 },
      { itemId: "starter_hero", windowKey: "U", count: 0 },
      { itemId: "iap_starter", windowKey: "U", count: 0 },
    ]);
    assert.deepEqual(state.firstPurchased, ["daily_gold"]);
  });

  it("checks requiredProgressId as stage, region:stage or region:stage:difficulty, ignoring case", async () => {
    const { wallets, shop, progress } = setup();
    wallets.set(USER, "gold", 10);
    await assert.rejects(shop.purchase(USER, { itemId: "gated" }), isError("SHOP_NOT_ELIGIBLE"));
    await assert.rejects(shop.purchase(USER, { itemId: "gated_stage" }), isError("SHOP_NOT_ELIGIBLE"));
    await progress.recordClear(USER, "region_1", "stage_3", "Normal", 1000);
    await assert.rejects(shop.purchase(USER, { itemId: "gated" }), isError("SHOP_NOT_ELIGIBLE"), "needs Easy");
    await shop.purchase(USER, { itemId: "gated_stage" });
    await progress.recordClear(USER, "region_1", "stage_3", "Easy", 1000);
    await shop.purchase(USER, { itemId: "gated" });
  });

  it("replays the first response for a retried purchaseId (no double spend)", async () => {
    const { wallets, shop } = setup();
    wallets.set(USER, "gem", 100);
    const first = await shop.purchase(USER, { itemId: "daily_gold", purchaseId: "retry-0001" });
    const retry = await shop.purchase(USER, { itemId: "daily_gold", purchaseId: "retry-0001" });
    assert.deepEqual(retry, first);
    assert.equal(wallets.amount(USER, "gem"), 95);
  });

  it("grants characters once per account and rejects unsupported items", async () => {
    const { wallets, characters, shop } = setup();
    wallets.set(USER, "gold", 500);

    const result = await shop.purchase(USER, { itemId: "starter_hero" });
    assert.equal(result.grants.characters[0].stars, 4);
    assert.equal(characters.records.size, 1);
    await assert.rejects(shop.purchase(USER, { itemId: "starter_hero" }), isError("SHOP_LIMIT_REACHED"));
    await assert.rejects(shop.purchase(USER, { itemId: "iap_pack" }), isError("IAP_NOT_SUPPORTED"));
    await assert.rejects(shop.purchase(USER, { itemId: "ghost_house" }), isError("SHOP_REWARD_NOT_SUPPORTED"));
    await assert.rejects(shop.purchase(USER, { itemId: "missing" }), isError("SHOP_ITEM_NOT_FOUND"));
  });

  it("persists construction grants in the inventory and replays a retried purchaseId without granting twice", async () => {
    const { wallets, shop, inventory, homes } = setup();
    wallets.set(USER, "gold", 100);

    const first = await shop.purchase(USER, { itemId: "huts", purchaseId: "huts-0001" });
    assert.deepEqual(first.grants.constructions, [{ buildableId: "hut", count: 2 }]);
    assert.equal(inventory.amount(USER, "hut"), 2);
    assert.deepEqual((await homes.getSnapshot(USER)).inventory, [{ buildableId: "hut", count: 2 }]);

    const retry = await shop.purchase(USER, { itemId: "huts", purchaseId: "huts-0001" });
    assert.deepEqual(retry, first);
    assert.equal(inventory.amount(USER, "hut"), 2);
    assert.equal(wallets.amount(USER, "gold"), 90);

    await shop.purchase(USER, { itemId: "huts" });
    assert.equal(inventory.amount(USER, "hut"), 4);
    assert.equal(inventory.amount("someone-else", "hut"), 0);
  });

  it("forceUnique grants one unit and rejects BEFORE charging when the player already owns the building", async () => {
    const { wallets, shop, inventory, homes } = setup();
    wallets.set(USER, "gold", 200);

    const first = await shop.purchase(USER, { itemId: "tower_pack" });
    assert.deepEqual(first.grants.constructions, [{ buildableId: "tower", count: 1 }]);
    assert.equal(wallets.amount(USER, "gold"), 150);

    await assert.rejects(shop.purchase(USER, { itemId: "tower_pack" }), isError("SHOP_ALREADY_OWNED"));
    assert.equal(wallets.amount(USER, "gold"), 150);
    assert.equal(inventory.amount(USER, "tower"), 1);

    // placed buildings count as owned too
    await homes.placeObject(USER, { islandId: "main", definitionId: "tower", originX: 0, originZ: 0, yawDegrees: 0 });
    assert.equal(inventory.amount(USER, "tower"), 0);
    await assert.rejects(shop.purchase(USER, { itemId: "tower_pack" }), isError("SHOP_ALREADY_OWNED"));
    assert.equal(wallets.amount(USER, "gold"), 150);
  });
});

/** Stands in for Google Play / App Store (verified in their own tests): trusts `transactionId`. */
class FakeStoreVerifier implements IapStoreVerifier {
  readonly store = "FakeStore";
  verified: string[] = [];
  acknowledged: string[] = [];
  claimedKey({ receipt }: { receipt: { transactionId?: string | null } }): string | null {
    return receipt.transactionId ? iapTransactionKey(this.store, receipt.transactionId) : null;
  }
  async verify({ receipt }: { receipt: { productId: string; transactionId?: string | null } }) {
    this.verified.push(receipt.transactionId!);
    return {
      store: this.store, productId: receipt.productId, transactionKey: this.claimedKey({ receipt })!, orderId: receipt.transactionId ?? null,
      environment: "Production", afterGrant: async () => { this.acknowledged.push(receipt.transactionId!); },
    };
  }
}

describe("ShopService real-money purchases", () => {
  const fakeStore = () => {
    const store = new FakeStoreVerifier();
    return { store, validator: new StoreIapReceiptValidator([store], true) };
  };
  const paid = (transactionId: string, productId = "com.game.pack") => ({ store: "FakeStore", productId, transactionId });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("delivers a verified receipt once, replays it for the same account and refuses it on another", async () => {
    const { store, validator } = fakeStore();
    const { shop, wallets, iapTransactions } = setup({ iap: validator });

    const first = await shop.purchase(USER, { itemId: "iap_pack", receipt: paid("t-1") });
    assert.equal(first.priceSpent, 0);
    assert.deepEqual(first.grants.currencies, [{ currencyId: "gem", amount: 70 }]);
    await settle();
    assert.deepEqual(store.acknowledged, ["t-1"], "after-grant step runs once the grant is committed");

    // The client retries until it can finish the store transaction: same answer, no second grant, no new verification.
    const retry = await shop.purchase(USER, { itemId: "iap_pack", receipt: paid("t-1"), purchaseId: "client-id-0002" });
    assert.deepEqual(retry, first);
    assert.deepEqual(store.verified, ["t-1"]);
    await settle();
    assert.deepEqual(store.acknowledged, ["t-1"]);

    await assert.rejects(shop.purchase("user-2", { itemId: "iap_pack", receipt: paid("t-1") }), isError("IAP_RECEIPT_USED"));
    await shop.purchase(USER, { itemId: "iap_pack", receipt: paid("t-2") });
    assert.equal(wallets.amount(USER, "gem"), 140);
    assert.deepEqual([...iapTransactions.rows.values()].map((row) => [row.userId, row.itemId, row.purchaseId.startsWith("iap-")]),
      [[USER, "iap_pack", true], [USER, "iap_pack", true]]);
  });

  it("refuses a receipt of another product, a receipt on a currency price and a purchase without a receipt", async () => {
    const { shop, wallets, iapTransactions } = setup({ iap: fakeStore().validator });
    wallets.set(USER, "gem", 100);
    await assert.rejects(shop.purchase(USER, { itemId: "iap_pack", receipt: paid("t-1", "com.game.other") }), isError("IAP_PRODUCT_MISMATCH"));
    await assert.rejects(shop.purchase(USER, { itemId: "daily_gold", receipt: paid("t-2", "com.game.other") }), isError("IAP_PRODUCT_MISMATCH"));
    await assert.rejects(shop.purchase(USER, { itemId: "iap_pack" }), isError("IAP_NOT_SUPPORTED"));
    await assert.rejects(shop.purchase(USER, { itemId: "iap_pack", receipt: { store: "Steam", productId: "com.game.pack", transactionId: "t-3" } }), isError("IAP_NOT_SUPPORTED"));
    assert.equal(iapTransactions.rows.size, 0, "a refused receipt can still be delivered later");
    assert.equal(wallets.amount(USER, "gem"), 100);
  });

  it("delivers a paid offer that closed meanwhile but still enforces its limit", async () => {
    const { shop, wallets, iapTransactions } = setup({ iap: fakeStore().validator });
    await assert.rejects(shop.iapCheck(USER, "iap_starter"), isError("SHOP_NOT_AVAILABLE"), "no new payment once the offer ended");

    const first = await shop.purchase(USER, { itemId: "iap_starter", receipt: paid("s-1", "com.game.starter") });
    assert.equal(wallets.amount(USER, "gem"), 500);
    await assert.rejects(shop.purchase(USER, { itemId: "iap_starter", receipt: paid("s-2", "com.game.starter") }), isError("SHOP_LIMIT_REACHED"));
    assert.equal(iapTransactions.rows.size, 1);
    // The delivered receipt still answers ok (sold out by now).
    assert.deepEqual(await shop.purchase(USER, { itemId: "iap_starter", receipt: paid("s-1", "com.game.starter") }), first);
  });

  it("demo purchases need the exported setting and the server permission, scoped per account", async () => {
    const { shop, wallets } = setup({ iap: new StoreIapReceiptValidator([], true) });
    const demo = { store: "Demo", productId: "com.game.pack", transactionId: "demo-0001" };
    await shop.purchase(USER, { itemId: "iap_pack", receipt: demo });
    await shop.purchase(USER, { itemId: "iap_pack", receipt: demo });
    await shop.purchase("user-2", { itemId: "iap_pack", receipt: demo });
    assert.equal(wallets.amount(USER, "gem"), 70);
    assert.equal(wallets.amount("user-2", "gem"), 70);
    assert.equal((await shop.getState(USER)).iapDemo, true);

    const locked = setup({ iap: new StoreIapReceiptValidator([], false) });
    await assert.rejects(locked.shop.purchase(USER, { itemId: "iap_pack", receipt: demo }), isError("IAP_DEMO_DISABLED"));
    assert.equal((await locked.shop.getState(USER)).iapDemo, false);
  });

  it("iap_check answers the product, the demo flag and the account token without charging", async () => {
    const { shop, wallets } = setup({ iap: fakeStore().validator });
    assert.deepEqual(await shop.iapCheck(USER, "iap_pack"),
      { ok: true, itemId: "iap_pack", productId: "com.game.pack", demo: true, accountToken: iapAccountToken(USER) });
    await assert.rejects(shop.iapCheck(USER, "daily_gold"), isError("IAP_NOT_SUPPORTED"));
    await assert.rejects(shop.iapCheck(USER, "missing"), isError("SHOP_ITEM_NOT_FOUND"));
    assert.equal(wallets.amount(USER, "gem"), 0);
    assert.match(iapAccountToken(USER), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
