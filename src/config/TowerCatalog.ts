// Trial-of-Ascension style towers (`towers.json`, exported from the Unity TowerDefinition asset). A tower is a map region
// of kind "tower" (floors = its stages) climbed one floor at a time; progress resets every season (monthly / weekly) and
// each floor's first-clear rewards can be earned again after a reset. See docs/PROTOCOL.md `map` → Towers.
// camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys } from "./ShopCatalog.js";

export const TOWER_RESETS = ["monthly", "weekly", "never"] as const;
export type TowerReset = (typeof TOWER_RESETS)[number];

const int = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);

/** Accepts the reset name (any case) or its C# enum ordinal. */
const reset = z.preprocess(
  (raw) => (typeof raw === "number" && Number.isInteger(raw) ? TOWER_RESETS[raw] ?? raw : typeof raw === "string" ? raw.trim().toLowerCase() : raw),
  z.enum(TOWER_RESETS),
);

export const TowerSchema = z.object({
  regionId: z.string().trim().min(1).max(64),
  reset: reset.default("monthly"),
  /** Seasons start at this UTC hour (day 1 of the month / first weekday of the week). */
  resetHourUtc: int(0, 0, 23),
  /** Weekly towers: first day of the week (0 = Sunday, 1 = Monday). */
  weekStartsOn: int(1, 0, 6),
  minAccountLevel: int(1, 1, 1000),
});
export type TowerConfig = z.infer<typeof TowerSchema>;

export const TowerCatalogSchema = z.object({
  towers: z.array(TowerSchema).max(20).default([]),
});
export type TowerCatalog = z.infer<typeof TowerCatalogSchema>;

let catalog: TowerCatalog = TowerCatalogSchema.parse({});

/** Parses and validates `towers.json` (throws on invalid data or a duplicate region). */
export function parseTowerCatalog(rawText: string): TowerCatalog {
  const result = TowerCatalogSchema.parse(camelizeKeys(JSON.parse(rawText)));
  const ids = result.towers.map((tower) => tower.regionId);
  if (new Set(ids).size !== ids.length) throw new Error("towers.json: duplicate regionId");
  return result;
}

export function getTowerCatalog(): TowerCatalog {
  return catalog;
}

/** Replaces the in-memory catalog (tests / programmatic setups). */
export function setTowerCatalog(next: TowerCatalog): void {
  catalog = next;
}

export function loadTowerCatalogOnce(): TowerCatalog {
  const file = locateCatalogFile("towers.json");
  if (!file) {
    console.warn("[TowerCatalog] towers.json not found; no towers.");
    return catalog;
  }
  catalog = parseTowerCatalog(fs.readFileSync(file, "utf8"));
  console.log(`[TowerCatalog] loaded ${catalog.towers.length} towers from: ${file}`);
  return catalog;
}

export async function reloadTowerCatalogFromFile(filePath: string): Promise<TowerCatalog> {
  catalog = parseTowerCatalog(await fsp.readFile(filePath, "utf8"));
  console.log(`[TowerCatalog] reloaded from: ${filePath}`);
  return catalog;
}

