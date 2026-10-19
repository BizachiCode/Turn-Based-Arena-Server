// Elemental dungeons (`dungeons.json`, exported from the Unity DungeonDefinition asset): which map regions are
// dungeon halls, the weekdays each hall is open, the account level it needs and the daily reset hour.
// The floors themselves (waves, energy, rewards, random drops) are the region's stages in `maps.json`.
// camelCase and PascalCase keys (JsonUtility output) are accepted. See docs/PROTOCOL.md `dungeon`.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys } from "./ShopCatalog.js";

const int = (fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const text = (max: number, fallback = "") => z.preprocess((raw) => (raw == null ? fallback : String(raw)), z.string().max(max));

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export const DUNGEON_KINDS = ["essence", "rune", "special"] as const;
export type DungeonKind = (typeof DUNGEON_KINDS)[number];

export const DungeonHallSchema = z.object({
  /** Map region (in `maps.json`) whose stages are this hall's floors. */
  regionId: z.string().trim().min(1).max(64),
  kind: z.preprocess((raw) => String(raw ?? "essence").toLowerCase(), z.enum(DUNGEON_KINDS)).catch("essence"),
  /** Element shown by the client (icon/colour); not used by the rules. */
  elementId: text(64),
  /** Weekdays the hall is open (0 = Sunday .. 6 = Saturday), evaluated after the daily reset hour. */
  openDays: z.array(z.coerce.number().int().min(0).max(6)).max(7).default([...ALL_WEEKDAYS])
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  /** Minimum account level to enter (1 = everyone). */
  minAccountLevel: int(1, 1, 9999),
});

export const DungeonConfigSchema = z.object({
  /** Hour (UTC) when a new dungeon day starts. */
  resetHourUtc: int(0, 0, 23),
  halls: z.array(DungeonHallSchema).max(64).default([]),
});

export type DungeonHall = z.infer<typeof DungeonHallSchema>;
export type DungeonConfig = z.infer<typeof DungeonConfigSchema>;

let catalog: DungeonConfig = DungeonConfigSchema.parse({});

/** Parses and validates `dungeons.json` (throws on invalid data). */
export function parseDungeonConfig(rawText: string): DungeonConfig {
  return DungeonConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
}

export function getDungeonConfig(): DungeonConfig {
  return catalog;
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setDungeonConfig(next: DungeonConfig): void {
  catalog = next;
}

export function loadDungeonConfigOnce(): DungeonConfig {
  const file = locateCatalogFile("dungeons.json");
  if (!file) {
    console.warn("[DungeonConfig] dungeons.json not found; no dungeon halls.");
    return catalog;
  }
  catalog = parseDungeonConfig(fs.readFileSync(file, "utf8"));
  console.log(`[DungeonConfig] loaded ${catalog.halls.length} halls from: ${file}`);
  return catalog;
}

export async function reloadDungeonConfigFromFile(filePath: string): Promise<DungeonConfig> {
  catalog = parseDungeonConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[DungeonConfig] reloaded from: ${filePath}`);
  return catalog;
}

