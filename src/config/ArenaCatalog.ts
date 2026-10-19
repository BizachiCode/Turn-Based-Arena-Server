// Server-side arena configuration (`arena.json`, exported from the Unity ArenaConfig asset): turn limit, Elo
// parameters, attack cost, opponent list rules, rewards, refresh cost, the NPC rivals that fill the opponent list and
// the seasons (tiers, season-end rewards, soft reset). See docs/ARENA.md.
// camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys } from "./ShopCatalog.js";

/** Integer (numeric strings accepted) with a default for absent fields. */
const int = (fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const CurrencyAmountSchema = z.object({ currencyId: z.string().min(1), amount: int(0, 0) });

export const ArenaNpcUnitSchema = z.object({
  characterId: z.string().min(1),
  star: int(1, 1, 6),
  level: int(1, 1),
  awakeningIndex: int(0, 0),
  skillLevels: z.array(z.number()).default([]),
});

export const ArenaNpcRivalSchema = z.object({
  id: z.string().min(1).max(48).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(32),
  rating: int(1000, 0),
  leaderSlotIndex: int(0, 0, 3),
  units: z.array(ArenaNpcUnitSchema).min(1).max(4),
});

/** `yyyy-MM-ddTHH:mm:ssZ` (UTC, no milliseconds): the Unity offline backend parses the same exact format. */
const ANCHOR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A real calendar instant written back identically (rejects e.g. Feb 30, which `Date.parse` would roll over). */
const isExactUtcInstant = (value: string) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().replace(".000Z", "Z") === value;
};

/** One season tier: reached with `rating >= minRating`; `rewards` are mailed when the season ends. */
export const ArenaSeasonTierSchema = z.object({
  id: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/),
  /** English display name: mail parameter and client fallback of `text_arena_tier_<id>` (empty = the id). */
  name: z.string().max(32).default(""),
  minRating: int(0, 0),
  rewards: z.array(CurrencyAmountSchema).default([]),
});

const tier = (id: string, name: string, minRating: number, rewards: Array<[string, number]>) =>
  ({ id, name, minRating, rewards: rewards.map(([currencyId, amount]) => ({ currencyId, amount })) });

/** Default tiers, ascending; the first one starts at 0 so every rating has a tier. */
export const DEFAULT_SEASON_TIERS = [
  tier("beginner", "Beginner", 0, [["GP", 50], ["GO", 5000]]),
  tier("challenger", "Challenger", 1100, [["GP", 100], ["GO", 10000]]),
  tier("fighter", "Fighter", 1250, [["GP", 200], ["GO", 20000], ["DM", 10]]),
  tier("conqueror", "Conqueror", 1400, [["GP", 350], ["GO", 35000], ["DM", 25]]),
  tier("guardian", "Guardian", 1600, [["GP", 500], ["GO", 50000], ["DM", 50]]),
  tier("legend", "Legend", 1800, [["GP", 800], ["GO", 80000], ["DM", 100]]),
];

/**
 * Arena seasons (docs/ARENA.md "Seasons"): season 1 starts at `anchor` (UTC) and a new one starts every `lengthDays`.
 * When a season ends, players with at least `minBattles` attacks in it get the rewards of the tier of their final
 * rating by mail, and every rating gets the soft reset `max(floor, base + round((rating - base) * keepPercent / 100))`.
 */
export const ArenaSeasonsSchema = z.object({
  enabled: z.boolean().default(true),
  lengthDays: int(7, 1, 365),
  anchor: z.string().regex(ANCHOR_PATTERN, "anchor must be yyyy-MM-ddTHH:mm:ssZ").refine(isExactUtcInstant, "anchor is not a valid UTC date")
    .default("2026-01-05T00:00:00Z"),
  minBattles: int(1, 0, 1000),
  reset: z.object({
    base: int(1000, 0),
    /** 0 = everyone back to `base`, 100 = no reset. */
    keepPercent: int(50, 0, 100),
    floor: int(0, 0),
  }).prefault({}),
  tiers: z.array(ArenaSeasonTierSchema).min(1).max(20).default(DEFAULT_SEASON_TIERS),
});

export const ArenaConfigSchema = z.object({
  turnLimit: int(60, 1, 500),
  kFactor: int(32, 1, 200),
  startRating: int(1000, 0),
  rewards: z.object({
    win: z.array(CurrencyAmountSchema).default([{ currencyId: "GP", amount: 10 }, { currencyId: "GO", amount: 2000 }]),
    loss: z.array(CurrencyAmountSchema).default([{ currencyId: "GP", amount: 2 }]),
  }).prefault({}),
  /** Arena Wings spent per attack (0 = attacks are free). */
  wingCost: int(1, 0, 100),
  /** Opponents offered in the list (real players first, NPC rivals fill the rest). */
  opponentCount: int(6, 1, 20),
  /**
   * Rating distances tried in order when looking for real players (ascending); after the last one any rating is
   * accepted, closest first.
   */
  ratingWindows: z.array(z.coerce.number().int().min(1)).max(10).default([200, 400]),
  /** Seconds between two free list refreshes. */
  freeRefreshSeconds: int(600, 0, 7 * 86_400),
  /** Seconds a defender is hidden from a player who just attacked it. */
  recentAttackHideSeconds: int(600, 0, 7 * 86_400),
  /** Entries shown in the defense log. */
  defenseLogSize: int(20, 1, 200),
  /** Players shown in the arena ranking. */
  rankingSize: int(100, 1, 1000),
  /** Price of an early opponent refresh (null = early refresh not allowed). */
  refreshCost: CurrencyAmountSchema.nullable().default({ currencyId: "DM", amount: 5 }),
  npcRivals: z.array(ArenaNpcRivalSchema).default([]),
  seasons: ArenaSeasonsSchema.prefault({}),
});

export type ArenaNpcUnit = z.infer<typeof ArenaNpcUnitSchema>;
export type ArenaNpcRival = z.infer<typeof ArenaNpcRivalSchema>;
export type ArenaSeasonTier = z.infer<typeof ArenaSeasonTierSchema>;
export type ArenaSeasonsConfig = z.infer<typeof ArenaSeasonsSchema>;
export type ArenaConfig = z.infer<typeof ArenaConfigSchema>;

/**
 * Season tiers must be sorted by `minRating` (strictly ascending, the first at 0) with unique ids, so every rating maps
 * to exactly one tier. Throws on the first problem.
 */
export function validateSeasonTiers(tiers: readonly ArenaSeasonTier[]): void {
  const ids = new Set<string>();
  tiers.forEach((entry, index) => {
    if (ids.has(entry.id)) throw new Error(`Duplicate arena season tier id: ${entry.id}`);
    ids.add(entry.id);
    if (index === 0 && entry.minRating !== 0) throw new Error(`The first arena season tier (${entry.id}) must have minRating 0`);
    if (index > 0 && entry.minRating <= tiers[index - 1].minRating) {
      throw new Error(`Arena season tiers must be sorted by minRating (strictly ascending): ${entry.id}`);
    }
  });
}

const DEFAULTS: ArenaConfig = ArenaConfigSchema.parse({});
let catalog: ArenaConfig = DEFAULTS;

/**
 * Parses and validates `arena.json` (throws a ZodError on invalid data; duplicate NPC ids and unsorted / duplicate
 * season tiers are rejected).
 */
export function parseArenaConfig(rawText: string): ArenaConfig {
  const result = ArenaConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
  const ids = new Set<string>();
  for (const npc of result.npcRivals) {
    if (ids.has(npc.id)) throw new Error(`Duplicate arena NPC id: ${npc.id}`);
    ids.add(npc.id);
  }
  validateSeasonTiers(result.seasons.tiers);
  result.ratingWindows.forEach((window, index) => {
    if (index > 0 && window <= result.ratingWindows[index - 1]) throw new Error("Arena ratingWindows must be strictly ascending");
  });
  return result;
}

export function getArenaConfig(): ArenaConfig {
  return catalog;
}

export function getArenaNpcById(id: string): ArenaNpcRival | undefined {
  return catalog.npcRivals.find((npc) => npc.id === id);
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setArenaConfig(next: ArenaConfig): void {
  catalog = next;
}

export function loadArenaConfigOnce(): ArenaConfig {
  const file = locateCatalogFile("arena.json");
  if (!file) {
    console.warn("[ArenaConfig] arena.json not found; using defaults without NPC rivals.");
    return catalog;
  }
  catalog = parseArenaConfig(fs.readFileSync(file, "utf8"));
  console.log(`[ArenaConfig] loaded ${catalog.npcRivals.length} NPC rivals from: ${file}`);
  return catalog;
}

export async function reloadArenaConfigFromFile(filePath: string): Promise<ArenaConfig> {
  catalog = parseArenaConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[ArenaConfig] reloaded ${catalog.npcRivals.length} NPC rivals from: ${filePath}`);
  return catalog;
}

