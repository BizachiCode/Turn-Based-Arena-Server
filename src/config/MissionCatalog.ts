// Daily missions and achievements (`missions.json`, exported from the Unity MissionDefinition asset).
// Daily missions reset every game day at `resetHourUtc`; claiming all of them unlocks the daily bonus. Achievements are
// one-time goals counted over the whole account. See docs/PROTOCOL.md `missions`.
// camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys, emptyPayload, ShopPackPayloadSchema, type ShopPackPayload } from "./ShopCatalog.js";

/**
 * Counted player actions (append new kinds at the end: the Unity `MissionKind` enum mirrors this order).
 * `account_level` is absolute (progress = the level reached); every other kind adds up.
 */
export const MISSION_KINDS = [
  "login",
  "stage_clear",
  "dungeon_clear",
  "arena_battle",
  "summon",
  "monster_powerup",
  "monster_evolve",
  "monster_awaken",
  "rune_upgrade",
  "energy_spent",
  "account_level",
  "tower_clear",
] as const;
export type MissionKind = (typeof MISSION_KINDS)[number];

/** Kinds whose progress is a reached value (max) instead of a running count. */
export const ABSOLUTE_MISSION_KINDS: ReadonlySet<MissionKind> = new Set(["account_level"]);

const int = (fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const configId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/);

/** Accepts the kind name or its C# enum ordinal. */
const missionKind = z.preprocess(
  (raw) => (typeof raw === "number" && Number.isInteger(raw) ? MISSION_KINDS[raw] ?? raw : raw),
  z.enum(MISSION_KINDS),
);

const MissionSchema = z.object({
  id: configId,
  kind: missionKind,
  target: int(1, 1, 100_000_000),
  rewards: ShopPackPayloadSchema.default(emptyPayload()),
});
export type MissionConfig = z.infer<typeof MissionSchema>;

const reward = (currencies: Array<{ currencyId: string; amount: number }>, extra: Partial<ShopPackPayload> = {}): ShopPackPayload =>
  ({ ...emptyPayload(), currencies, ...extra });

/** Sample daily missions (used until a `missions.json` is exported). */
export const DEFAULT_DAILY_MISSIONS: z.input<typeof MissionSchema>[] = [
  { id: "daily_login", kind: "login", target: 1, rewards: reward([{ currencyId: "GO", amount: 2000 }]) },
  { id: "daily_stages", kind: "stage_clear", target: 3, rewards: reward([{ currencyId: "EN", amount: 10 }]) },
  { id: "daily_energy", kind: "energy_spent", target: 30, rewards: reward([{ currencyId: "GO", amount: 5000 }]) },
  { id: "daily_arena", kind: "arena_battle", target: 3, rewards: reward([{ currencyId: "GP", amount: 30 }]) },
  { id: "daily_powerup", kind: "monster_powerup", target: 1, rewards: reward([{ currencyId: "GO", amount: 3000 }]) },
];

/** Sample achievements. */
export const DEFAULT_ACHIEVEMENTS: z.input<typeof MissionSchema>[] = [
  { id: "ach_level_5", kind: "account_level", target: 5, rewards: reward([{ currencyId: "DM", amount: 50 }]) },
  { id: "ach_level_10", kind: "account_level", target: 10, rewards: reward([{ currencyId: "DM", amount: 100 }]) },
  { id: "ach_stages_10", kind: "stage_clear", target: 10, rewards: reward([{ currencyId: "DM", amount: 30 }]) },
  { id: "ach_dungeon_10", kind: "dungeon_clear", target: 10, rewards: reward([{ currencyId: "DM", amount: 50 }]) },
  { id: "ach_summon_10", kind: "summon", target: 10, rewards: reward([{ currencyId: "DM", amount: 50 }]) },
  { id: "ach_evolve_1", kind: "monster_evolve", target: 1, rewards: reward([{ currencyId: "DM", amount: 30 }]) },
  { id: "ach_awaken_1", kind: "monster_awaken", target: 1, rewards: reward([{ currencyId: "DM", amount: 50 }]) },
];

export const MissionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Daily missions reset at this UTC hour. */
  resetHourUtc: int(0, 0, 23),
  daily: z.array(MissionSchema).max(30).default(() => DEFAULT_DAILY_MISSIONS.map((mission) => MissionSchema.parse(mission))),
  /** Claimable once a day after every daily mission was claimed (empty = no bonus). */
  dailyBonus: ShopPackPayloadSchema.default(() => reward([{ currencyId: "DM", amount: 20 }])),
  achievements: z.array(MissionSchema).max(500).default(() => DEFAULT_ACHIEVEMENTS.map((mission) => MissionSchema.parse(mission))),
});
export type MissionsConfig = z.infer<typeof MissionConfigSchema>;

let catalog: MissionsConfig = MissionConfigSchema.parse({});

/** Parses and validates `missions.json` (throws on invalid data or duplicate ids). */
export function parseMissionConfig(rawText: string): MissionsConfig {
  const result = MissionConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
  const ids = [...result.daily, ...result.achievements].map((mission) => mission.id);
  if (new Set(ids).size !== ids.length) throw new Error("missions.json: duplicate mission id");
  return result;
}

export function getMissionConfig(): MissionsConfig {
  return catalog;
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setMissionConfig(next: MissionsConfig): void {
  catalog = next;
}

export function loadMissionConfigOnce(): MissionsConfig {
  const file = locateCatalogFile("missions.json");
  if (!file) {
    console.warn("[MissionConfig] missions.json not found; using the sample missions.");
    return catalog;
  }
  catalog = parseMissionConfig(fs.readFileSync(file, "utf8"));
  console.log(`[MissionConfig] loaded ${catalog.daily.length} daily missions / ${catalog.achievements.length} achievements from: ${file}`);
  return catalog;
}

export async function reloadMissionConfigFromFile(filePath: string): Promise<MissionsConfig> {
  catalog = parseMissionConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[MissionConfig] reloaded from: ${filePath}`);
  return catalog;
}

