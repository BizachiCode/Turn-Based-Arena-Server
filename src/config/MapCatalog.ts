import fs from "fs";
import * as fsp from "fs/promises";

/**
 * Server-side Map Catalog (`maps.json`, exported by the Unity `MapJsonExporter`):
 * {
 *   "version": "1.4",
 *   "generatedAtUnix": 1710000000,
 *   "dropTables": [
 *     { "id": "drops_r1_easy",
 *       "rune": { "chance": 0.25, "stars": [{ "stars": 1, "weight": 70 }, { "stars": 2, "weight": 30 }],
 *                 "grades": [{ "grade": 1, "weight": 55 }, ...], "sets": [] },          // grade 1 Normal .. 5 Legend
 *       "items": [{ "currencyId": "magic_low", "min": 1, "max": 2, "chance": 0.12 }] }
 *   ],
 *   "regions": [
 *     { "id": "r1", "kind": "story", "stages": [
 *         { "id": "s1",
 *           "energyCurrencyId": "EN",
 *           "energyCost": [1,2,3,4],                              // Easy, Normal, Hard, Hell
 *           "formation": { "front": 1, "back": 2, "leaderIndex": 0 },
 *           "scene": "Region1_Forest",
 *           "waves": [{ "waveIndex": 0, "enemies": [{ "characterId": "...", "stars": 2, "level": 5, ... }] }],
 *           "rewards": [{ "difficulty": "Easy", "currencies": [...], "dropTableId": "drops_r1_easy", "randomDrops": [] }],
 *           "difficultyScaling": [...], "turnLimit": 30
 *         }
 *     ]}
 *   ]
 * }
 *
 * The file is normalized to {@link MapCatalog}.
 */

/* ---------- types (normalized / in-server) ---------- */

import { STAGE_DIFFICULTIES, type StageDifficulty } from "../shared/kernel/types.js";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";

export type { StageDifficulty };
const DIFFS: readonly StageDifficulty[] = STAGE_DIFFICULTIES;
function isDiff(x: any): x is StageDifficulty {
  return typeof x === "string" && (DIFFS as readonly string[]).includes(x);
}

export type StageCost = { difficulty: StageDifficulty; amount: number };

export type Formation = {
  /** number of front-line slots */
  front: number;
  /** number of back-line slots */
  back: number;
  /** index in [0..(front+back-1)] */
  leaderIndex: number;
};

export type EnemyStats = {
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;
  critRate?: number;
  critDamage?: number;
  resistance?: number;
  accuracy?: number;
};

export type StageWave = {
  /** 0-based wave index */
  waveIndex: number;
  /** enemies for this wave */
  enemies: StageEnemy[];
};

export type StageEnemy = {
  characterId: string;
  stars: number;
  level: number;
  awakeningIndex: number;
  isBoss?: boolean;
  isLeader?: boolean;
  stats?: EnemyStats;
};

/** Rewards of one stage difficulty (`maps.json > stage.rewards[]`). Missing fields grant nothing. */
export type StageRewardEntry = {
  difficulty: StageDifficulty;
  /** Granted on every victory. */
  currencies: Array<{ currencyId: string; amount: number }>;
  /** Granted only on the first clear of this stage + difficulty. */
  firstClearCurrencies: Array<{ currencyId: string; amount: number }>;
  /** EXP granted to every unit that took part (alive or dead). */
  unitExp: number;
  /** Account EXP of a victory (0 = energy spent x `accountExp.expPerEnergy`). */
  accountExp: number;
  /** Shared drop table (`maps.json > dropTables[]`) rolled on every victory; resolved from `dropTableId` at load. */
  dropTable?: StageDropTable;
  /** Extra independent rolls of this stage only (dungeon essences, a boss bonus...), rolled after the table's items. */
  randomDrops: StageRandomDrop[];
};

/** One random drop roll: `chance` (0..1) to receive `min..max` of a currency. */
export type StageRandomDrop = {
  currencyId: string;
  min: number;
  max: number;
  chance: number;
};

/** Weighted rune star (1..6). */
export type RuneStarWeight = { stars: number; weight: number };
/** Weighted rune grade (1 = Normal, 2 = Magic, 3 = Rare, 4 = Hero, 5 = Legend). */
export type RuneGradeWeight = { grade: number; weight: number };

/** Rune part of a drop table: `chance` (0..1) of one rune, its stars and grade picked by weight, set from `sets`. */
export type RuneDropTable = {
  chance: number;
  stars: RuneStarWeight[];
  grades: RuneGradeWeight[];
  /** Rune sets the drop is picked from (empty = any set). */
  sets: string[];
};

/**
 * Shared drop table (`maps.json > dropTables[]`, exported from the Unity `StageDropTable` assets): an optional rune
 * roll and independent item rolls (essences, scrolls, bonus Lunar Stones...). Stages reference it per difficulty.
 */
export type StageDropTable = {
  id: string;
  rune: RuneDropTable | null;
  items: StageRandomDrop[];
};

/** Enemy scaling of one difficulty (`maps.json > stage.difficultyScaling[]`). */
export type DifficultyScaling = {
  difficulty: StageDifficulty;
  /** Added to every enemy level (result clamped to >= 1). */
  levelBonus: number;
  /** Multiplies enemy HP / ATK / DEF (speed and rate stats are unchanged). */
  statMultiplier: number;
};

export type MapStage = {
  /** stage id */
  id: string;

  /** currency id that pays the cost (the stage export always sets it; "EN" in the template) */
  currencyId: string;

  /** one entry per difficulty (always 4, Easy..Hell) */
  costs: StageCost[];

  /** team composition constraints */
  formation: Formation;

  /** enemy waves, fought in order */
  waves?: StageWave[];

  /** Per-difficulty rewards (ordered Easy..Hell). */
  rewards?: StageRewardEntry[];

  /** Per-difficulty enemy scaling (ordered Easy..Hell). */
  difficultyScaling?: DifficultyScaling[];

  /** Optional battle turn limit (the battle ends as a defeat/draw when reached). */
  turnLimit?: number;

  /** battle scene of the stage */
  scene?: string;
};

/** `story` regions form the campaign unlock chain; `dungeon` regions are halls with their own floor-by-floor unlock. */
export type RegionKind = "story" | "dungeon" | "tower";

export type MapRegion = {
  /** region id */
  id: string;
  kind: RegionKind;
  stageCount: number;
  stages: MapStage[];
};

export type MapCatalog = {
  version?: string;
  generatedAtUnix?: number;
  regions: MapRegion[];
  /** Drop tables by id (stage rewards keep a resolved reference). */
  dropTables?: Record<string, StageDropTable>;
};

/* ---------- internal state ---------- */

let _maps: MapCatalog = { regions: [] };

/* ---------- normalizers ---------- */

/** Energy cost per difficulty from `energyCost` ([Easy, Normal, Hard, Hell]; missing entries cost 0). */
function normalizeCosts(s: any): StageCost[] {
  const energyCost: unknown[] = Array.isArray(s?.energyCost) ? s.energyCost : [];
  return DIFFS.map((difficulty, i) => ({ difficulty, amount: Math.max(0, Number(energyCost[i] ?? 0) | 0) }));
}

/** Formation `{ front, back, leaderIndex }` (leader clamped to the slots). */
function normalizeFormation(s: any): Formation {
  const f = s?.formation || {};
  const front = Math.max(0, Number(f.front ?? 0) | 0);
  const back  = Math.max(0, Number(f.back ?? 0) | 0);
  const total = front + back;
  let leader  = Number(f.leaderIndex ?? 0) | 0;
  if (total <= 0) return { front: 0, back: 0, leaderIndex: 0 };
  leader = Math.min(Math.max(0, leader), total - 1);
  return { front, back, leaderIndex: leader };
}

/** Waves with at least one enemy, ordered by `waveIndex` (defaults to the list position). */
function normalizeWaves(s: any): StageWave[] {
  const wavesIn: any[] = Array.isArray(s?.waves) ? s.waves : [];
  const out: StageWave[] = [];

  for (let i = 0; i < wavesIn.length; i++) {
    const w = wavesIn[i];
    if (!w) continue;

    const enemies = normalizeEnemies(w);
    if (enemies.length === 0) continue;

    out.push({ waveIndex: Math.max(0, Number(w.waveIndex ?? i) | 0), enemies });
  }

  out.sort((a, b) => a.waveIndex - b.waveIndex);
  return out;
}

function normalizeEnemies(w: any): StageEnemy[] {
  const src: any[] = Array.isArray(w?.enemies) ? w.enemies : [];
  const out: StageEnemy[] = [];

  for (const e of src) {
    const characterId = typeof e?.characterId === "string" ? e.characterId.trim() : "";
    if (!characterId) continue;

    const stars = Math.min(Math.max(1, Number(e.stars ?? 1) | 0), 6);
    const level = Math.max(1, Number(e.level ?? 1) | 0);
    const awakeningIndex = Math.max(0, Number(e.awakeningIndex ?? 0) | 0);

    const statsRaw = e.stats;
    const stats: EnemyStats | undefined = statsRaw && typeof statsRaw === "object"
      ? {
          maxHp: Math.max(1, Number(statsRaw.maxHp ?? 0) | 0),
          attack: Math.max(0, Number(statsRaw.attack ?? 0) | 0),
          defense: Math.max(0, Number(statsRaw.defense ?? 0) | 0),
          speed: Math.max(0, Number(statsRaw.speed ?? 0) | 0),
          critRate: statsRaw.critRate != null ? Number(statsRaw.critRate) : undefined,
          critDamage: statsRaw.critDamage != null ? Number(statsRaw.critDamage) : undefined,
          resistance: statsRaw.resistance != null ? Number(statsRaw.resistance) : undefined,
          accuracy: statsRaw.accuracy != null ? Number(statsRaw.accuracy) : undefined,
        }
      : undefined;

    out.push({
      characterId,
      stars,
      level,
      awakeningIndex,
      isBoss: !!e.isBoss,
      isLeader: !!e.isLeader,
      stats: (stats && stats.maxHp > 0) ? stats : undefined,
    });
  }

  return out;
}

function normalizeCurrencyList(raw: any): Array<{ currencyId: string; amount: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ currencyId: string; amount: number }> = [];
  for (const entry of raw) {
    const currencyId = String(entry?.currencyId ?? "").trim();
    const amount = Math.floor(Number(entry?.amount ?? 0));
    if (currencyId && Number.isFinite(amount) && amount > 0) out.push({ currencyId, amount });
  }
  return out;
}

/** Resolves the difficulty of an entry: explicit `difficulty`, else its position (Easy..Hell). */
function entryDifficulty(entry: any, index: number): StageDifficulty | null {
  if (isDiff(entry?.difficulty)) return entry.difficulty;
  return index < DIFFS.length ? DIFFS[index] : null;
}

function normalizeRandomDrops(raw: any): StageRandomDrop[] {
  if (!Array.isArray(raw)) return [];
  const out: StageRandomDrop[] = [];
  for (const entry of raw) {
    const currencyId = String(entry?.currencyId ?? "").trim();
    const min = Math.max(0, Math.floor(Number(entry?.min ?? 0)) || 0);
    const max = Math.max(min, Math.floor(Number(entry?.max ?? min)) || min);
    const chance = Math.min(1, Math.max(0, Number(entry?.chance ?? 0) || 0));
    if (currencyId && max > 0 && chance > 0) out.push({ currencyId, min: Math.max(1, min), max, chance });
  }
  return out;
}

function normalizeRuneSets(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((entry: any) => String(entry ?? "").trim()).filter((id: string) => id.length > 0))];
}

/** Positive weights of `key` values inside `min..max` (duplicates merged). */
function normalizeWeights<K extends "stars" | "grade">(raw: any, key: K, min: number, max: number): Array<Record<K, number> & { weight: number }> {
  if (!Array.isArray(raw)) return [];
  const merged = new Map<number, number>();
  for (const entry of raw) {
    const value = Math.floor(Number(entry?.[key]));
    const weight = Number(entry?.weight ?? 0);
    if (!Number.isFinite(value) || value < min || value > max || !(weight > 0)) continue;
    merged.set(value, (merged.get(value) ?? 0) + weight);
  }
  return [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([value, weight]) => ({ [key]: value, weight }) as Record<K, number> & { weight: number });
}

/** Rune roll of a table; null when it can never drop a rune (no chance or no star weights). */
function normalizeRuneDrop(raw: any): RuneDropTable | null {
  const chance = Math.min(1, Math.max(0, Number(raw?.chance ?? 0) || 0));
  const stars = normalizeWeights(raw?.stars, "stars", 1, 6);
  if (chance <= 0 || stars.length === 0) return null;
  const grades = normalizeWeights(raw?.grades, "grade", 1, 5);
  return { chance, stars, grades: grades.length > 0 ? grades : [{ grade: 1, weight: 1 }], sets: normalizeRuneSets(raw?.sets) };
}

/** `dropTables: [{ id, rune, items }]` → tables by id (later duplicates are ignored). */
export function normalizeDropTables(raw: any): Record<string, StageDropTable> {
  const out: Record<string, StageDropTable> = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const id = String(entry?.id ?? "").trim();
    if (!id || out[id]) continue;
    out[id] = { id, rune: normalizeRuneDrop(entry.rune), items: normalizeRandomDrops(entry.items) };
  }
  return out;
}

function normalizeRewards(raw: any, tables: Record<string, StageDropTable>): StageRewardEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: StageRewardEntry[] = [];
  raw.forEach((entry: any, index: number) => {
    const difficulty = entryDifficulty(entry, index);
    if (!entry || !difficulty) return;
    const tableId = String(entry.dropTableId ?? "").trim();
    if (tableId && !tables[tableId]) console.warn(`[MapCatalog] unknown drop table '${tableId}' (stage reward ignored it)`);
    out.push({
      difficulty,
      currencies: normalizeCurrencyList(entry.currencies),
      firstClearCurrencies: normalizeCurrencyList(entry.firstClearCurrencies),
      unitExp: Math.max(0, Math.floor(Number(entry.unitExp ?? 0)) || 0),
      accountExp: Math.max(0, Math.floor(Number(entry.accountExp ?? 0)) || 0),
      ...(tableId && tables[tableId] ? { dropTable: tables[tableId] } : {}),
      randomDrops: normalizeRandomDrops(entry.randomDrops),
    });
  });
  return out.length ? out : undefined;
}

function normalizeDifficultyScaling(raw: any): DifficultyScaling[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: DifficultyScaling[] = [];
  raw.forEach((entry: any, index: number) => {
    const difficulty = entryDifficulty(entry, index);
    if (!entry || !difficulty) return;
    const multiplier = Number(entry.statMultiplier ?? 1);
    out.push({
      difficulty,
      levelBonus: Math.floor(Number(entry.levelBonus ?? 0)) || 0,
      statMultiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1,
    });
  });
  return out.length ? out : undefined;
}

/** Normalizes the parsed export (`{ version, generatedAtUnix, regions: [] }`) to the server shape. */
function normalizeMaps(parsed: any): MapCatalog {
  const dropTables = normalizeDropTables(parsed?.dropTables);
  const out: MapCatalog = {
    version: parsed?.version ?? "1.0",
    generatedAtUnix: Number(parsed?.generatedAtUnix || Date.now() / 1000) | 0,
    regions: [],
    dropTables,
  };

  if (!Array.isArray(parsed?.regions)) {
    console.warn("[MapCatalog] invalid format; expected { regions: [] }");
    return out;
  }

  for (const r of parsed.regions) {
    if (!r?.id) continue;

    const region: MapRegion = { id: String(r.id), kind: regionKind(r.kind), stageCount: 0, stages: [] };

    const stagesIn: any[] = Array.isArray(r.stages) ? r.stages : [];
    for (const s of stagesIn) {
      if (!s?.id) continue;

      const waves = normalizeWaves(s);
      const currencyId = typeof s.energyCurrencyId === "string" ? s.energyCurrencyId.trim() : "";

      region.stages.push({
        id: String(s.id),
        scene: typeof s.scene === "string" && s.scene.length > 0 ? s.scene : undefined,
        currencyId,
        costs: normalizeCosts(s),
        formation: normalizeFormation(s),
        waves: waves.length ? waves : undefined,
        rewards: normalizeRewards(s.rewards, dropTables),
        difficultyScaling: normalizeDifficultyScaling(s.difficultyScaling),
        turnLimit: Number.isFinite(Number(s.turnLimit)) && Number(s.turnLimit) > 0 ? Math.floor(Number(s.turnLimit)) : undefined,
      });
    }

    region.stageCount = region.stages.length;
    out.regions.push(region);
  }

  return out;
}

/** Parses an export without changing the current catalog (tests, tools). */
export function parseMapCatalog(rawText: string): MapCatalog {
  return normalizeMaps(JSON.parse(rawText));
}

/** Parses the export text and makes it the current catalog. */
function applyMapsText(rawText: string): MapCatalog {
  let parsed: unknown = null;
  try { parsed = JSON.parse(rawText); } catch { parsed = null; }
  _maps = normalizeMaps(parsed);
  return _maps;
}

/* ---------- public API ---------- */

export function loadMapCatalogOnce(): MapCatalog { return loadInternal(true); }
export function reloadMapCatalog(): MapCatalog   { return loadInternal(false); }

export function getStageWaves(regionId: string, stageId: string): StageWave[] | undefined {
  return getStageById(regionId, stageId)?.waves;
}

export async function reloadMapCatalogFromFile(filePath: string): Promise<MapCatalog> {
  applyMapsText(await fsp.readFile(filePath, "utf8"));
  console.log("[MapCatalog] reloaded from file:", filePath, "regions:", _maps.regions.length);
  return _maps;
}

function loadInternal(warnIfMissing: boolean): MapCatalog {
  try {
    const chosen = locateCatalogFile("maps.json");
    if (!chosen) {
      const msg = "[MapCatalog] maps file not found in any of: " + JSON.stringify(configDirs());
      warnIfMissing ? console.warn(msg) : console.log(msg);
      return _maps;
    }

    applyMapsText(fs.readFileSync(chosen, "utf8"));
    console.log("[MapCatalog] loaded", _maps.regions.length, "regions from:", chosen);
    return _maps;
  } catch (e) {
    console.error("[MapCatalog] load error:", e);
    _maps = { regions: [] };
    return _maps;
  }
}

export function getMapCatalog(): MapCatalog { return _maps?.regions ? _maps : { regions: [] }; }
/** Campaign regions in unlock order (dungeon halls and towers excluded: they never gate the story difficulties). */
export function storyRegions(catalog: MapCatalog): MapRegion[] {
  return catalog.regions.filter((region) => region.kind !== "dungeon" && region.kind !== "tower");
}
export function getRegionById(id: string): MapRegion | undefined {
  return getMapCatalog().regions.find(r => r.id === id);
}
export function getStageById(regionId: string, stageId: string): MapStage | undefined {
  const r = getRegionById(regionId);
  return r?.stages.find(s => s.id === stageId);
}
export function getStageCost(regionId: string, stageId: string, diff: StageDifficulty): number {
  const s = getStageById(regionId, stageId);
  return s ? getStageCostFor(s, diff) : 0;
}
/** Rewards configured for a difficulty (undefined => nothing is granted). */
export function getStageRewardFor(stage: MapStage, diff: StageDifficulty): StageRewardEntry | undefined {
  return stage.rewards?.find((entry) => entry.difficulty === diff);
}
/** Enemy scaling for a difficulty (identity when not configured). */
export function getDifficultyScalingFor(stage: MapStage, diff: StageDifficulty): DifficultyScaling {
  return stage.difficultyScaling?.find((entry) => entry.difficulty === diff) ?? { difficulty: diff, levelBonus: 0, statMultiplier: 1 };
}
export function getStageCostFor(stage: MapStage, diff: StageDifficulty): number {
  const hit = stage.costs.find(c => c.difficulty === diff);
  return Math.max(0, hit?.amount ?? 0);
}
export function getStageFormation(regionId: string, stageId: string): Formation | undefined {
  return getStageById(regionId, stageId)?.formation;
}

/** `dungeon` / `tower` regions; anything else is a story region. */
function regionKind(raw: unknown): RegionKind {
  const kind = String(raw ?? "").trim().toLowerCase();
  return kind === "dungeon" || kind === "tower" ? kind : "story";
}
