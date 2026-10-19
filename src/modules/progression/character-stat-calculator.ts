import type {
  AwakeningStepDTO,
  CharacterDTO,
  GrowthDTO,
  StarLevelStatsDTO,
  StarOverrideDTO,
  StatMultDTO,
  StatsDTO,
} from "../../config/DTO/characterCatalogDto.js";
import { liveProgressionRules } from "./live-progression-rules.js";

/*
 * Character stat formula — a port of Unity `CharacterData.GetStatsFor` (and `StatBlockExtensions`), so the
 * server, the offline backend and the client compute the same numbers:
 *   1. manual per-level tables (awakening table first, then the character table) when enabled and covering the level;
 *   2. otherwise base stats x star multipliers + linear per-level growth, then the awakening layers.
 * Integer stats are rounded after every step (half to even, single precision) exactly like `Mathf.RoundToInt`.
 */

const FALLBACK_MAX_LEVEL_BY_STAR = [20, 25, 30, 35, 40, 50];

const ONE_MUL: StatMultDTO = { hp: 1, atk: 1, def: 1, spd: 1, sh: 1, cr: 1, cd: 1, res: 1, acc: 1, eva: 1 };
const DEFAULT_PER_LEVEL: GrowthDTO = { hp: 0.03, atk: 0.03, def: 0.03, spd: 0, cr: 0, cd: 0, res: 0, acc: 0, eva: 0 };
const ZERO_GROWTH: GrowthDTO = { hp: 0, atk: 0, def: 0, spd: 0, cr: 0, cd: 0, res: 0, acc: 0, eva: 0 };
const ZERO_STATS: StatsDTO = { hp: 0, atk: 0, def: 0, spd: 0, sh: 0, cr: 0, cd: 0, res: 0, acc: 0, eva: 0 };

const f32 = Math.fround;

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `Mathf.RoundToInt`: banker's rounding of a single-precision value. */
function roundToInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Chance stats leave the single-precision math rounded to 6 decimals (0.15 instead of 0.15000000596). */
function tidy(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return tidy(Math.max(0, Math.min(1, v)));
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return tidy(Math.max(min, Math.min(max, v)));
}

function nonNegativeInt(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

function statsOf(raw: Partial<StatsDTO> | undefined): StatsDTO {
  const s = raw ?? {};
  return {
    hp: num(s.hp), atk: num(s.atk), def: num(s.def), spd: num(s.spd), sh: num(s.sh),
    cr: num(s.cr), cd: num(s.cd), res: num(s.res), acc: num(s.acc), eva: num(s.eva),
  };
}

function mul(s: StatsDTO, raw: StatMultDTO | undefined): StatsDTO {
  const m = raw ?? ONE_MUL;
  return {
    hp: roundToInt(f32(s.hp * f32(num(m.hp, 1)))),
    atk: roundToInt(f32(s.atk * f32(num(m.atk, 1)))),
    def: roundToInt(f32(s.def * f32(num(m.def, 1)))),
    spd: roundToInt(f32(s.spd * f32(num(m.spd, 1)))),
    sh: roundToInt(f32(s.sh * f32(num(m.sh, 1)))),
    cr: f32(s.cr * f32(num(m.cr, 1))),
    cd: f32(s.cd * f32(num(m.cd, 1))),
    res: f32(s.res * f32(num(m.res, 1))),
    acc: f32(s.acc * f32(num(m.acc, 1))),
    eva: f32(s.eva * f32(num(m.eva, 1))),
  };
}

/** `AddPercentLinear`: integer stats grow by a percentage of the base, chance stats grow additively. */
function growLinear(s: StatsDTO, raw: GrowthDTO | undefined, levelsGained: number): StatsDTO {
  if (levelsGained <= 0) return s;
  const g = raw ?? ZERO_GROWTH;
  const L = levelsGained;
  const scale = (value: number, pct: unknown) => roundToInt(f32(value * f32(1 + f32(f32(num(pct)) * L))));
  const plus = (value: number, pct: unknown) => f32(value + f32(f32(num(pct)) * L));
  return {
    hp: scale(s.hp, g.hp),
    atk: scale(s.atk, g.atk),
    def: scale(s.def, g.def),
    spd: scale(s.spd, g.spd),
    sh: s.sh,
    cr: plus(s.cr, g.cr),
    cd: plus(s.cd, g.cd),
    res: plus(s.res, g.res),
    acc: plus(s.acc, g.acc),
    eva: plus(s.eva, g.eva),
  };
}

function add(s: StatsDTO, raw: StatsDTO | undefined): StatsDTO {
  if (!raw) return s;
  const b = statsOf(raw);
  return {
    hp: s.hp + b.hp, atk: s.atk + b.atk, def: s.def + b.def, spd: s.spd + b.spd, sh: s.sh + b.sh,
    cr: f32(s.cr + b.cr), cd: f32(s.cd + b.cd), res: f32(s.res + b.res), acc: f32(s.acc + b.acc), eva: f32(s.eva + b.eva),
  };
}

function findStarOverride(list: StarOverrideDTO[] | undefined, star: number): StarOverrideDTO | undefined {
  return Array.isArray(list) ? list.find((o) => o && o.star === star) : undefined;
}

function findManualLevel(tables: StarLevelStatsDTO[] | undefined, star: number, level: number): StatsDTO | null {
  if (!Array.isArray(tables)) return null;
  const table = tables.find((t) => t && t.star === star);
  if (!table || !Array.isArray(table.levels) || level < 1 || level > table.levels.length) return null;
  return statsOf(table.levels[level - 1]);
}

function findStep(ch: CharacterDTO, awakeningIndex: number): AwakeningStepDTO | undefined {
  const steps = Array.isArray(ch.awakenings) ? ch.awakenings : [];
  return steps.find((a) => a && a.index === awakeningIndex) ?? steps[awakeningIndex - 1];
}

/** Max level of a star tier from the live `config.json` star tiers (Unity `GameInstance.GetTier`). */
export function maxLevelAtStar(star: number): number {
  const s = Math.max(1, Math.min(6, Math.floor(star)));
  try {
    const tier = liveProgressionRules.starTiers().find((t) => t.stars === s);
    if (tier) return Math.max(1, Math.floor(tier.maxLevel));
  } catch {
    // config not loaded yet: use the fallback table
  }
  return FALLBACK_MAX_LEVEL_BY_STAR[s - 1] ?? 50;
}

function formulaStats(ch: CharacterDTO, star: number, level: number, step: AwakeningStepDTO | undefined): StatsDTO {
  const gained = level - 1;
  const tuning = step?.tuning;
  const customBase = !!tuning?.useCustomBaseStats;

  const base = customBase ? statsOf(tuning?.baseStats) : statsOf(ch.baseStats);
  const params = customBase ? findStarOverride(tuning?.starOverrides, star) : findStarOverride(ch.starOverrides, star);

  let out = mul(base, params?.baseMul ?? ONE_MUL);
  out = growLinear(out, params?.perLevel ?? DEFAULT_PER_LEVEL, gained);

  if (step && tuning) {
    if (!customBase) {
      const awParams = findStarOverride(tuning.starOverrides, star);
      if (awParams) {
        out = mul(out, awParams.baseMul);
        out = growLinear(out, awParams.perLevel, gained);
      }
    }
    out = growLinear(out, tuning.perLevelBonus, gained);
    out = add(out, tuning.flatBonus);
    out = add(out, step.rewards?.extraFlatBonus);
  }
  return out;
}

export type ComputeStatsResult =
  | { ok: true; stats: StatsDTO }
  | { ok: false; error: string };

/**
 * Computes the final stats of a character at a star / level / awakening step (0 = not awakened) from the
 * character catalog. Deterministic: no database and no invented values.
 */
export function computeCharacterStats(
  ch: CharacterDTO,
  star: number,
  level: number,
  awakeningIndex: number,
): ComputeStatsResult {
  if (!ch) return { ok: false, error: "Missing character." };
  if (!ch.baseStats) return { ok: false, error: `Character ${ch.id} missing baseStats.` };

  const s = Math.max(1, Math.min(6, Math.floor(num(star, 1))));
  const lv = Math.max(1, Math.min(maxLevelAtStar(s), Math.floor(num(level, 1))));

  const awk = Math.max(0, Math.floor(num(awakeningIndex)));
  const step = awk > 0 ? findStep(ch, awk) : undefined;
  if (awk > 0 && !step) return { ok: false, error: `Character ${ch.id} missing awakening step index=${awk}.` };

  const tuning = step?.tuning;
  const manual =
    (tuning?.useManualStarLevelStats ? findManualLevel(tuning.manualStarLevelStats, s, lv) : null) ??
    (ch.useManualStarLevelStats ? findManualLevel(ch.manualStarLevelStats, s, lv) : null);

  let out: StatsDTO;
  if (manual) {
    out = manual;
    if (step && tuning) {
      out = add(out, tuning.flatBonus ?? ZERO_STATS);
      out = add(out, step.rewards?.extraFlatBonus);
    }
  } else {
    out = formulaStats(ch, s, lv, step);
  }

  return {
    ok: true,
    stats: {
      hp: nonNegativeInt(out.hp),
      atk: nonNegativeInt(out.atk),
      def: nonNegativeInt(out.def),
      spd: nonNegativeInt(out.spd),
      sh: nonNegativeInt(out.sh),
      cr: clamp01(out.cr),
      cd: clamp(out.cd, 1, 5),
      res: clamp01(out.res),
      acc: clamp01(out.acc),
      eva: clamp01(out.eva),
    },
  };
}
