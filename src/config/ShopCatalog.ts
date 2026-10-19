// Server-side shop catalog (`shop.json`, exported from the Unity ShopCatalog / ShopItemDefinition
// assets). Field names mirror the C# classes in camelCase; PascalCase keys and numeric enums
// (JsonUtility output) are accepted too. See docs/CONFIG_FORMATS.md.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";

const ITEM_TYPES = ["Currency", "Character", "Construction", "SummonScroll", "RunePack", "Cosmetic", "Pack", "Subscription", "Custom"] as const;
const PRICE_KINDS = ["SoftCurrency", "HardCurrency", "RealMoneyIAP"] as const;
const LIMIT_SCOPES = ["None", "Lifetime", "PerAccount", "Daily", "Weekly", "Monthly"] as const;
const AVAILABILITY_MODES = ["Always", "DateRangeUtc", "RotationTag"] as const;
const DISCOUNT_MODES = ["None", "PercentOff", "FixedOff"] as const;
const PLACEMENTS = ["DefaultGrid", "Banner", "Starter", "Weekly", "Monthly", "HotDeals", "Rotation", "Exchange"] as const;

/** Accepts the enum name or its C# ordinal. */
function enumOf<const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) {
  return z.preprocess((raw) => {
    if (typeof raw === "number" && Number.isInteger(raw)) return values[raw] ?? fallback;
    if (typeof raw === "string" && raw.length > 0) return raw;
    return fallback;
  }, z.enum(values));
}

/** ISO-8601 string, unix seconds or unix milliseconds → Date (null when absent). */
const utcDate = z.preprocess((raw) => {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return new Date(raw > 1e12 ? raw : raw * 1000);
  if (typeof raw === "string") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}, z.date().nullable());

const int = (fallback = 0) => z.preprocess((raw) => (raw == null || raw === "" ? fallback : Number(raw)), z.number().int());
const str = z.preprocess((raw) => (raw == null ? null : String(raw)), z.string().nullable());

export const PriceEntrySchema = z.object({
  kind: enumOf(PRICE_KINDS, "HardCurrency"),
  currencyId: str.default(null),
  amount: int(0).pipe(z.number().min(0)),
  iapProductId: str.default(null),
  realMoneyDisplay: str.default(null),
});

const CurrencyGrantSchema = z.object({ currencyId: z.string().min(1), amount: int(0).pipe(z.number().min(0)) });
const CharacterGrantSchema = z.object({
  characterId: z.string().min(1),
  star: int(1).pipe(z.number().min(1).max(6)),
  level: int(1).pipe(z.number().min(1)),
  awakeningIndex: int(0).pipe(z.number().min(0)),
  duplicateGivesShards: z.boolean().default(true),
  duplicateCompCurrencyId: str.default(null),
  duplicateCompAmount: int(0).pipe(z.number().min(0)),
});
const ConstructionGrantSchema = z.object({ buildableId: z.string().min(1), count: int(1), forceUnique: z.boolean().default(false) });
const ScrollGrantSchema = z.object({ scrollId: z.string().min(1), quantity: int(1).pipe(z.number().min(1)) });
/** Unset marker from JsonUtility exports: null, "" and 0 all mean "roll it". */
const unsetToNull = (raw: unknown) => (raw == null || raw === "" || raw === 0 || raw === "0" ? null : raw);

/** Random runes (Unity `ShopPackPayload.Runes`); null / "" / 0 fields are rolled. */
const RuneGrantSchema = z.object({
  setId: z.preprocess(unsetToNull, z.string().nullable()).default(null),
  slot: z.preprocess((raw) => { const v = unsetToNull(raw); return v == null ? null : Number(v); }, z.number().int().min(1).max(6).nullable()).default(null),
  tier: int(1).pipe(z.number().min(1).max(6)),
  quality: z.preprocess((raw) => { const v = unsetToNull(raw); return v == null ? null : Number(v); }, z.number().int().min(1).max(5).nullable()).default(null),
  quantity: int(1).pipe(z.number().min(1).max(50)),
});

export const ShopPackPayloadSchema = z.object({
  currencies: z.array(CurrencyGrantSchema).default([]),
  characters: z.array(CharacterGrantSchema).default([]),
  constructions: z.array(ConstructionGrantSchema).default([]),
  scrolls: z.array(ScrollGrantSchema).default([]),
  runes: z.array(RuneGrantSchema).default([]),
});

export const ShopItemSchema = z.object({
  itemId: z.string().min(1).max(64),
  displayName: str.default(null),
  description: str.default(null),
  iconId: str.default(null),
  itemType: enumOf(ITEM_TYPES, "Pack"),
  placements: z.array(enumOf(PLACEMENTS, "DefaultGrid")).default([]),
  sortPriority: int(0),
  availability: z.object({
    mode: enumOf(AVAILABILITY_MODES, "Always"),
    startUtc: utcDate.default(null),
    endUtc: utcDate.default(null),
    rotationTag: str.default(null),
  }).default({ mode: "Always", startUtc: null, endUtc: null, rotationTag: null }),
  minAccountLevel: int(0),
  requiredProgressId: str.default(null),
  basePrices: z.array(PriceEntrySchema).default([]),
  progressiveTiers: z.array(z.object({ fromPurchaseIndex: int(0), price: PriceEntrySchema })).default([]),
  discounts: z.array(z.object({
    mode: enumOf(DISCOUNT_MODES, "None"),
    percentOff: int(0).pipe(z.number().min(0).max(100)),
    fixedOffAmount: int(0).pipe(z.number().min(0)),
    startUtc: utcDate.default(null),
    endUtc: utcDate.default(null),
  })).default([]),
  limit: z.object({
    scope: enumOf(LIMIT_SCOPES, "None"),
    maxPurchases: int(1).pipe(z.number().min(1)),
    giveFirstPurchaseBonus: z.boolean().default(false),
    uniquePerAccount: z.boolean().default(false),
    weekStartsOn: int(1).pipe(z.number().min(0).max(6)),
    resetHourUtc: int(0).pipe(z.number().min(0).max(23)),
  }).default({ scope: "None", maxPurchases: 1, giveFirstPurchaseBonus: false, uniquePerAccount: false, weekStartsOn: 1, resetHourUtc: 0 }),
  rewards: ShopPackPayloadSchema.default({ currencies: [], characters: [], constructions: [], scrolls: [], runes: [] }),
  firstPurchaseBonus: ShopPackPayloadSchema.default({ currencies: [], characters: [], constructions: [], scrolls: [], runes: [] }),
});

/** Trimmed text; empty means "not set" (null). */
const optionalText = z.preprocess((raw) => (raw == null || String(raw).trim() === "" ? null : String(raw).trim()), z.string().max(255).nullable());

/**
 * Real-money purchases (Unity `ShopCatalog.Iap`). Store credentials are secrets and stay in the server `.env`
 * (docs/IAP.md); everything else is game data exported from Unity.
 */
export const IapSettingsSchema = z.object({
  /**
   * Demo builds: RealMoneyIAP items are granted with a `Demo` receipt, without any payment. In production the server
   * also needs `IAP_DEMO_PURCHASES=true` in its `.env`, so a demo export can never give items away on a live game.
   */
  demoPurchases: z.boolean().default(false),
  /** Accepts Apple Sandbox / TestFlight and Google Play license-tester purchases (App Review buys in the Sandbox). */
  allowTestPurchases: z.boolean().default(true),
  /** Android application id of the game (Google Play purchases). Empty = Google Play disabled. */
  googlePackageName: optionalText.default(null),
  /** iOS / macOS bundle id of the game (App Store purchases). Empty = App Store disabled. */
  appleBundleId: optionalText.default(null),
  /** Numeric Apple ID of the app in App Store Connect (0 = not set). */
  appleAppId: int(0).pipe(z.number().min(0)),
}).prefault({});

export const ShopCatalogSchema = z.object({
  version: str.default("1.0"),
  activeRotationTags: z.array(z.string()).default([]),
  items: z.array(ShopItemSchema).default([]),
  iap: IapSettingsSchema,
});

export type PriceEntry = z.infer<typeof PriceEntrySchema>;
export type ShopPackPayload = z.infer<typeof ShopPackPayloadSchema>;

/** A payload that grants nothing (catalog defaults). */
export function emptyPayload(): ShopPackPayload {
  return { currencies: [], characters: [], constructions: [], scrolls: [], runes: [] };
}
export type ShopItem = z.infer<typeof ShopItemSchema>;
export type ShopCatalog = z.infer<typeof ShopCatalogSchema>;
export type IapSettings = z.infer<typeof IapSettingsSchema>;

let catalog: ShopCatalog = ShopCatalogSchema.parse({});

/** Lower-cases the first letter of every key (accepts PascalCase JsonUtility output). */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.length > 0 ? key[0].toLowerCase() + key.slice(1) : key,
      camelizeKeys(entry),
    ]));
  }
  return value;
}

/** Parses and validates a shop catalog (throws a ZodError on invalid data). */
export function parseShopCatalog(rawText: string): ShopCatalog {
  const parsed = camelizeKeys(JSON.parse(rawText)) as Record<string, unknown> | unknown[];
  const root = Array.isArray(parsed) ? { items: parsed } : parsed;
  const result = ShopCatalogSchema.parse(root);
  const ids = new Set<string>();
  for (const item of result.items) {
    if (ids.has(item.itemId)) throw new Error(`Duplicate shop itemId: ${item.itemId}`);
    ids.add(item.itemId);
  }
  return result;
}

export function getShopCatalog(): ShopCatalog {
  return catalog;
}

export function getShopItemById(itemId: string): ShopItem | undefined {
  return catalog.items.find((item) => item.itemId === itemId);
}

/** Replaces the in-memory catalog (tests / programmatic setups). */
export function setShopCatalog(next: ShopCatalog): void {
  catalog = next;
}

export function loadShopCatalogOnce(): ShopCatalog {
  const file = locateCatalogFile("shop.json");
  if (!file) {
    console.warn("[ShopCatalog] shop.json not found; the shop is empty.");
    return catalog;
  }
  catalog = parseShopCatalog(fs.readFileSync(file, "utf8"));
  console.log(`[ShopCatalog] loaded ${catalog.items.length} items from: ${file}`);
  warnDemoPurchases();
  return catalog;
}

export async function reloadShopCatalogFromFile(filePath: string): Promise<ShopCatalog> {
  catalog = parseShopCatalog(await fsp.readFile(filePath, "utf8"));
  console.log(`[ShopCatalog] reloaded ${catalog.items.length} items from: ${filePath}`);
  warnDemoPurchases();
  return catalog;
}

function warnDemoPurchases(): void {
  if (catalog.iap.demoPurchases) {
    console.warn("[ShopCatalog] iap.demoPurchases is ON: real-money items are granted WITHOUT payment (demo builds only; production also needs IAP_DEMO_PURCHASES=true).");
  }
}

