import fs from "fs";
import * as fsp from "fs/promises";
import path from "path";
import { locateCatalogFile } from "./catalog-file-locator.js";

/* -----------------------------------------------------------------------------
 * Server-side Rune Catalog
 * 
 * Unity exporter emits six files:
 *   runes/rune_sets.json
 *   runes/rune_slot_rules.json
 *   runes/rune_main_curves.json
 *   runes/rune_substat_rolls.json
 *   runes/rune_grinds.json
 *   runes/rune_config.json
 * 
 * This module loads, normalizes, and indexes data for fast access at runtime.
 * Files are located with the shared `locateCatalogFile` rule (bundle copies under `runes/`).
 * ---------------------------------------------------------------------------*/

/* ---------- types (normalized) ---------- */

export type RuneSetSpecialEffect = { type: string; valueA?: number; valueB?: number };

export type RuneSet = {
  id: string;                    // enum name (e.g., "Energy")
  displayName?: string;
  requiredCount: number;         // 2/4 pieces, etc.
  scope: "SelfOnly" | "EntireTeam";
  percentBonuses?: {
    MaxHP?: number; Attack?: number; Defense?: number; Speed?: number;
    CritRate?: number; CritDamage?: number; Resistance?: number; Accuracy?: number; Evasion?: number;
  };
  specialEffects?: RuneSetSpecialEffect[];
};

export type RuneSlotRule = { slot: number; allowedMainStats: string[] };

export type RuneMainCurve = {
  stat: string;                  // e.g., "HPPercent"
  tier: number;                  // 1..6
  variant: string;               // "Normal" | "Ancient"
  valuesByLevel: number[];       // size 16, indexes 0..15
};

export type RuneSubstatRoll = {
  stat: string;
  tier: number;
  variant: string;
  discreteOptions?: number[] | null;
  min?: number;
  max?: number;
};

export type RuneGrind = { stat: string; tier: number; variant: string; min: number; max: number };

export type RuneConfig = {
  maxLevel: number;
  upgradeBreakpoints: number[];
  initialSubstatsByQuality: number[];
  onlyCraftedAcceptGemsAndGrinds: boolean;
  gemEligibleSubstats: string[];

  /** Success chance per target level (index = level you want to reach). */
  upgradeSuccessPercentByLevel: number[];
  /** Base cost per attempt per target level (index = level you want to reach). */
  upgradeCostByLevel: number[];
  /** Currency id used for upgrade costs (e.g., "GO"). */
  costCurrencyId: string;
  /** Whether runes can break on upgrade (server is source of truth). */
  runesCanBreakOnUpgrade: boolean;
};

export type RuneCatalog = {
  sets: RuneSet[];
  slotRules: RuneSlotRule[];
  mainCurves: RuneMainCurve[];
  substatRolls: RuneSubstatRoll[];
  grinds: RuneGrind[];
  config: RuneConfig;
};

/* ---------- state ---------- */

let _runes: RuneCatalog = {
  sets: [],
  slotRules: [],
  mainCurves: [],
  substatRolls: [],
  grinds: [],
  config: {
    maxLevel: 15,
    upgradeBreakpoints: [3, 6, 9, 12],
    initialSubstatsByQuality: [0, 1, 2, 3, 4],
    onlyCraftedAcceptGemsAndGrinds: true,
    gemEligibleSubstats: [],

    // ---- defaults ----
    upgradeSuccessPercentByLevel: [],
    upgradeCostByLevel: [],
    costCurrencyId: "GO",
    runesCanBreakOnUpgrade: false
  }
};

/* Fast lookup caches (rebuilt on reload) */
let _curveIndex = new Map<string, number[]>();     // key: "stat|tier|variant"
let _slotIndex = new Map<number, Set<string>>();   // slot -> allowed main stats
let _rollIndex  = new Map<string, RuneSubstatRoll>();
let _grindIndex = new Map<string, RuneGrind>();

/* ---------- file locations ---------- */

const FILES = {
  sets:         "rune_sets.json",
  slotRules:    "rune_slot_rules.json",
  mainCurves:   "rune_main_curves.json",
  substatRolls: "rune_substat_rolls.json",
  grinds:       "rune_grinds.json",
  config:       "rune_config.json",
};


/* ---------- normalizers ---------- */

function normalizeArray<T>(rawText: string, label: string): T[] {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) return parsed as T[];
    console.warn(`[RuneCatalog] ${label}: invalid format, expected the exported root array`);
    return [];
  } catch (e) {
    console.warn(`[RuneCatalog] ${label}: JSON parse error`, e);
    return [];
  }
}

function coerceIntArray(a: unknown, min = -Infinity, max = Infinity): number[] {
  if (!Array.isArray(a)) return [];
  return a.map((x) => {
    const n = Number(x);
    const i = Number.isFinite(n) ? (n | 0) : 0;
    return Math.max(min, Math.min(max, i));
  });
}

function normalizeConfig(rawText: string): RuneConfig {
  try {
    const p = JSON.parse(rawText) || {};

    const cfg: RuneConfig = {
      maxLevel: Number(p.maxLevel ?? 15) | 0,
      upgradeBreakpoints: Array.isArray(p.upgradeBreakpoints)
        ? p.upgradeBreakpoints.map((x: any) => Number(x) | 0)
        : [3, 6, 9, 12],
      initialSubstatsByQuality: Array.isArray(p.initialSubstatsByQuality)
        ? p.initialSubstatsByQuality.map((x: any) => Number(x) | 0)
        : [0, 1, 2, 3, 4],
      onlyCraftedAcceptGemsAndGrinds: !!p.onlyCraftedAcceptGemsAndGrinds,
      gemEligibleSubstats: Array.isArray(p.gemEligibleSubstats)
        ? p.gemEligibleSubstats.map(String)
        : [],

      // ---- fields ----
      upgradeSuccessPercentByLevel: coerceIntArray(p.upgradeSuccessPercentByLevel, 0, 100),
      upgradeCostByLevel: coerceIntArray(p.upgradeCostByLevel, 0, Number.MAX_SAFE_INTEGER),
      costCurrencyId: typeof p.costCurrencyId === "string" && p.costCurrencyId.trim()
        ? p.costCurrencyId.trim()
        : "GO",
      runesCanBreakOnUpgrade: !!p.runesCanBreakOnUpgrade
    };

    // Safety: clamp maxLevel to reasonable bounds
    if (!Number.isFinite(cfg.maxLevel) || cfg.maxLevel < 1) cfg.maxLevel = 15;

    return cfg;
  } catch {
    console.warn("[RuneCatalog] rune_config: parse error, using defaults");
    return _runes.config;
  }
}

/* ---------- load one file with candidates ---------- */

function loadJSONOrEmpty(fileName: string, isArray: boolean): any {
  const chosen = locateCatalogFile(fileName, `runes/${fileName}`);
  if (!chosen) return isArray ? [] : {};
  try {
    const raw = fs.readFileSync(chosen, "utf8");
    return isArray ? JSON.parse(raw) : JSON.parse(raw);
  } catch (e) {
    console.error(`[RuneCatalog] failed to read ${fileName} at`, chosen, e);
    return isArray ? [] : {};
  }
}

/* ---------- indexing ---------- */

function buildIndexes(): void {
  _curveIndex.clear();
  _slotIndex.clear();
  _rollIndex.clear();
  _grindIndex.clear();

  for (const c of _runes.mainCurves) {
    const key = `${c.stat}|${c.tier}|${c.variant}`;
    _curveIndex.set(key, c.valuesByLevel || []);
  }
  for (const r of _runes.slotRules) {
    const set = new Set((r.allowedMainStats || []).map(String));
    _slotIndex.set(Number(r.slot)|0, set);
  }
  for (const r of _runes.substatRolls) {
    const key = `${r.stat}|${r.tier}|${r.variant}`;
    _rollIndex.set(key, r);
  }
  for (const g of _runes.grinds) {
    const key = `${g.stat}|${g.tier}|${g.variant}`;
    _grindIndex.set(key, g);
  }
}

/* ---------- API: load/reload ---------- */

export function loadRuneCatalogOnce(): RuneCatalog {
  if (_runes.sets.length || _runes.slotRules.length || _runes.mainCurves.length) return _runes;
  return reloadRuneCatalog();
}

/** Reloads all rune files from the search locations (newest of the plain file and the bundle copy). */
export function reloadRuneCatalog(): RuneCatalog {
  try {
    const setsRaw         = loadJSONOrEmpty(FILES.sets, true);
    const slotRulesRaw    = loadJSONOrEmpty(FILES.slotRules, true);
    const mainCurvesRaw   = loadJSONOrEmpty(FILES.mainCurves, true);
    const substatRollsRaw = loadJSONOrEmpty(FILES.substatRolls, true);
    const grindsRaw       = loadJSONOrEmpty(FILES.grinds, true);
    const configRaw       = loadJSONOrEmpty(FILES.config, false);

    _runes = {
      sets: normalizeArray<RuneSet>(JSON.stringify(setsRaw),         "rune_sets"),
      slotRules: normalizeArray<RuneSlotRule>(JSON.stringify(slotRulesRaw), "rune_slot_rules"),
      mainCurves: normalizeArray<RuneMainCurve>(JSON.stringify(mainCurvesRaw), "rune_main_curves"),
      substatRolls: normalizeArray<RuneSubstatRoll>(JSON.stringify(substatRollsRaw), "rune_substat_rolls"),
      grinds: normalizeArray<RuneGrind>(JSON.stringify(grindsRaw),   "rune_grinds"),
      config: normalizeConfig(JSON.stringify(configRaw)),
    };

    buildIndexes();

    console.log("[RuneCatalog] loaded",
      `sets=${_runes.sets.length}`,
      `slotRules=${_runes.slotRules.length}`,
      `curves=${_runes.mainCurves.length}`,
      `rolls=${_runes.substatRolls.length}`,
      `grinds=${_runes.grinds.length}`,
      `maxLvl=${_runes.config.maxLevel}`,
      `succArr=${_runes.config.upgradeSuccessPercentByLevel.length}`,
      `costArr=${_runes.config.upgradeCostByLevel.length}`,
      `currency=${_runes.config.costCurrencyId}`
    );
    return _runes;
  } catch (e) {
    console.error("[RuneCatalog] reload error:", e);
    return _runes;
  }
}

/** Reloads from a specific directory (e.g., freshly extracted bundle dir). */
export async function reloadRuneCatalogFromDir(dir: string): Promise<RuneCatalog> {
  // Temporarily push dir to the front by reading explicit files there.
  const read = async (p: string, def: any) => {
    try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return def; }
  };
  const base = (name: string) => path.join(dir, "runes", name);

  const sets         = await read(base(FILES.sets), []);
  const slotRules    = await read(base(FILES.slotRules), []);
  const mainCurves   = await read(base(FILES.mainCurves), []);
  const substatRolls = await read(base(FILES.substatRolls), []);
  const grinds       = await read(base(FILES.grinds), []);
  const config       = await read(base(FILES.config), {});

  _runes = {
    sets: normalizeArray<RuneSet>(JSON.stringify(sets), "rune_sets"),
    slotRules: normalizeArray<RuneSlotRule>(JSON.stringify(slotRules), "rune_slot_rules"),
    mainCurves: normalizeArray<RuneMainCurve>(JSON.stringify(mainCurves), "rune_main_curves"),
    substatRolls: normalizeArray<RuneSubstatRoll>(JSON.stringify(substatRolls), "rune_substat_rolls"),
    grinds: normalizeArray<RuneGrind>(JSON.stringify(grinds), "rune_grinds"),
    config: normalizeConfig(JSON.stringify(config)),
  };
  buildIndexes();
  console.log("[RuneCatalog] reloaded from dir:", dir);
  return _runes;
}

/* ---------- getters & helpers ---------- */

export function getRuneCatalog(): RuneCatalog { return _runes; }

export function getRuneSetById(id: string): RuneSet | undefined {
  return _runes.sets.find(s => s.id === id);
}

export function isMainStatAllowed(slot: number, stat: string): boolean {
  const set = _slotIndex.get(slot);
  return !!(set && set.has(stat));
}

export function getMainStatValue(stat: string, tier: number, variant: string, level: number): number {
  const clampedLvl = Math.max(0, Math.min((_runes.config?.maxLevel ?? 15), level|0));
  const key = `${stat}|${tier}|${variant}`;
  const arr = _curveIndex.get(key);
  return Array.isArray(arr) && arr.length > clampedLvl ? Number(arr[clampedLvl] ?? 0) | 0 : 0;
}

export function getSubstatRoll(stat: string, tier: number, variant: string): RuneSubstatRoll | undefined {
  return _rollIndex.get(`${stat}|${tier}|${variant}`);
}
export function getGrindRange(stat: string, tier: number, variant: string): RuneGrind | undefined {
  return _grindIndex.get(`${stat}|${tier}|${variant}`);
}

export function getUpgradeSuccessChance(currentLevel: number): number {
  const cfg = _runes.config;
  const target = Math.max(0, Math.min(cfg.maxLevel, (currentLevel | 0) + 1));
  const arr = cfg.upgradeSuccessPercentByLevel || [];
  const val = arr[target];
  return Number.isFinite(val) ? Math.max(0, Math.min(100, val | 0)) : 100;
}

export function getUpgradeCost(currentLevel: number): number {
  const cfg = _runes.config;
  const target = Math.max(0, Math.min(cfg.maxLevel, (currentLevel | 0) + 1));
  const arr = cfg.upgradeCostByLevel || [];
  const val = arr[target];
  return Number.isFinite(val) ? Math.max(0, val | 0) : 0;
}

export function getUpgradeCurrencyId(): string {
  return _runes.config?.costCurrencyId || "GO";
}

export function getRunesCanBreakOnUpgrade(): boolean {
  return !!_runes.config?.runesCanBreakOnUpgrade;
}
