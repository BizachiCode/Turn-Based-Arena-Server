// Leaderboards (`ranking.json`, exported from the Unity RankingDefinition asset): which categories exist, their order,
// size, cache refresh interval and the texts/icon the client shows. See docs/PROTOCOL.md `ranking`.
// camelCase and PascalCase keys (JsonUtility output) are accepted. Missing file = the sample categories below.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys } from "./ShopCatalog.js";

/**
 * What a category ranks (computed from existing tables, no extra schema):
 * - `level`: account level, then experience;
 * - `arena`: arena rating;
 * - `tower`: floors cleared in the current season (all towers added up, or the one in `regionId`);
 * - `story`: stages cleared in the story regions, each weighted by its difficulty (`difficultyWeights`);
 * - `collection`: distinct monsters owned (bag + storage);
 * - `guild`: guild activity points of the current week (ranks guilds, not players).
 */
export const RANKING_KINDS = ["level", "arena", "tower", "story", "collection", "guild"] as const;
export type RankingKind = (typeof RANKING_KINDS)[number];

export const RANKING_MAX_TOP = 100;

const int = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const text = (max: number, fallback = "") => z.preprocess((raw) => (raw == null ? fallback : String(raw).trim()), z.string().max(max));

/** Accepts the kind name (any case) or its C# enum ordinal. */
const kind = z.preprocess(
  (raw) => (typeof raw === "number" && Number.isInteger(raw) ? RANKING_KINDS[raw] ?? raw : typeof raw === "string" ? raw.trim().toLowerCase() : raw),
  z.enum(RANKING_KINDS),
);

export const RankingCategorySchema = z.object({
  /** Unique id sent by the client (`ranking/list { category }`). */
  id: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_.-]+$/),
  kind,
  enabled: z.boolean().default(true),
  /** Ascending display order. */
  order: int(0, -1000, 1000),
  titleKey: text(64),
  descriptionKey: text(64),
  /** Translation key of the value text (`{0}` = the value, e.g. "Lv. {0}"). */
  valueKey: text(64),
  /** Icon id the client resolves to a sprite. */
  iconId: text(64),
  /** Entries kept in the cached list (1..100); 0 = the default of the file. */
  topSize: int(0, 0, RANKING_MAX_TOP),
  /** Seconds the cached list is reused before it is recomputed; 0 = the default of the file. */
  refreshSeconds: int(0, 0, 86_400),
  /** `tower` only: ranks that tower; empty = every tower added up. */
  regionId: text(64),
  /** `story` only: points per stage cleared at Easy / Normal / Hard / Hell. */
  difficultyWeights: z.array(z.coerce.number().int().min(0).max(1000)).max(4).default([1, 2, 3, 4]),
}).transform((category) => ({
  ...category,
  difficultyWeights: [0, 1, 2, 3].map((index) => category.difficultyWeights[index] ?? [1, 2, 3, 4][index]),
}));
export type RankingCategoryConfig = z.output<typeof RankingCategorySchema>;

const category = (
  id: string, kindName: RankingKind, order: number, iconId: string, valueKey: string,
): z.input<typeof RankingCategorySchema> => ({
  id,
  kind: kindName,
  order,
  titleKey: `ranking_${id}_title`,
  descriptionKey: `ranking_${id}_desc`,
  valueKey,
  iconId,
});

/** Categories of the sample content (used until a `ranking.json` is exported). */
export const DEFAULT_RANKING_CATEGORIES: z.input<typeof RankingCategorySchema>[] = [
  category("level", "level", 0, "rank_level", "ranking_value_level"),
  category("arena", "arena", 1, "rank_arena", "ranking_value_rating"),
  category("tower", "tower", 2, "rank_tower", "ranking_value_floors"),
  category("story", "story", 3, "rank_story", "ranking_value_points"),
  category("collection", "collection", 4, "rank_collection", "ranking_value_monsters"),
  category("guild", "guild", 5, "rank_guild", "ranking_value_points"),
];

export const RankingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Entries returned when the request has no `limit` (and the list size of categories with `topSize` 0). */
  defaultTopSize: int(50, 1, RANKING_MAX_TOP),
  /** Seconds a category list is cached (categories with `refreshSeconds` 0 use it). */
  defaultRefreshSeconds: int(120, 5, 86_400),
  categories: z.array(RankingCategorySchema).max(32).default(() => DEFAULT_RANKING_CATEGORIES.map((entry) => RankingCategorySchema.parse(entry))),
});

export type RankingConfig = z.output<typeof RankingConfigSchema>;

let catalog: RankingConfig = RankingConfigSchema.parse({});

/** Parses and validates `ranking.json` (throws on invalid data or a duplicate category id). */
export function parseRankingConfig(rawText: string): RankingConfig {
  const result = RankingConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
  const ids = result.categories.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("ranking.json: duplicate category id");
  return result;
}

export function getRankingConfig(): RankingConfig {
  return catalog;
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setRankingConfig(next: RankingConfig): void {
  catalog = next;
}

export function loadRankingConfigOnce(): RankingConfig {
  const file = locateCatalogFile("ranking.json");
  if (!file) {
    console.warn("[RankingConfig] ranking.json not found; using defaults.");
    return catalog;
  }
  catalog = parseRankingConfig(fs.readFileSync(file, "utf8"));
  console.log(`[RankingConfig] loaded ${catalog.categories.length} categories from: ${file}`);
  return catalog;
}

export async function reloadRankingConfigFromFile(filePath: string): Promise<RankingConfig> {
  catalog = parseRankingConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[RankingConfig] reloaded from: ${filePath}`);
  return catalog;
}

