import type { StatusId } from "../types/battle-data";

export type CombatTimingFormula = {
  defaultTurnThreshold: number;
  turnBarHeadroomMultiplier: number;
};

/** Turn order systems (docs/BATTLE_RULES.md "Turn order"). */
export const TURN_ORDER_MODES = ["AttackBar", "SpeedRounds", "AlternatingSides", "TeamPhase"] as const;

/**
 * - `AttackBar`: Attack bar (ATB) filled by speed.
 * - `SpeedRounds`: every living unit acts once per round, fastest first.
 * - `AlternatingSides`: the sides take turns, each side's fastest unit that has not acted yet.
 * - `TeamPhase`: a whole side acts (any order), then the other side.
 */
export type TurnOrderMode = typeof TURN_ORDER_MODES[number];

export type CombatTurnOrderFormula = {
  mode: TurnOrderMode;
  /**
   * TeamPhase: attack bar granted to every unit of a side when its phase is charged, above the 100% needed to act
   * (0.5 = charged to 150%: an attack bar decrease of more than 50% before the unit acts makes it skip the phase).
   */
  teamPhaseSkipThreshold: number;
  /** SpeedRounds / AlternatingSides / TeamPhase: highest attack bar, in multiples of the turn threshold (default 3). */
  roundModeTurnBarCap: number;
};

/** How debuff landing is resolved. */
export type DebuffResistanceModel =
  /** Roll the base chance, then the target resists with `max(minimumResistChance, RES - ACC)`. */
  | "resist_floor"
  /** Linear: a single roll against `clamp(base + (ACC - RES) * accuracyVsResistanceWeight, minimumDebuffChance, maximumDebuffChance)`. */
  | "linear";

export type CombatAccuracyFormula = {
  baseHitChance: number;
  accuracyVsEvasionWeight: number;
  minimumHitChance: number;
  maximumHitChance: number;
  accuracyVsResistanceWeight: number;
  minimumDebuffChance: number;
  maximumDebuffChance: number;
  /** Default `resist_floor`. */
  debuffResistanceModel?: DebuffResistanceModel;
  /** Minimum resist chance for the `resist_floor` model (default 0.15). */
  minimumResistChance?: number;
  /** Maximum resist chance for the `resist_floor` model (default 1). */
  maximumResistChance?: number;
};

export type CombatDamageFormula = {
  minimumDamage: number;
  defaultDefenseConstant: number;
  useCriticalDamageStat: boolean;
  allowCriticalOnGlancing: boolean;
  glancingChanceOnElementDisadvantage: number;
  glancingDamageMultiplier: number;
  elementalAdvantageDamageMultiplier: number;
  elementalDisadvantageDamageMultiplier: number;
  elementalNeutralDamageMultiplier: number;
  /** Crit rate added when attacking with elemental advantage (default 0.15). */
  criticalRateBonusOnElementAdvantage?: number;
  /** Crit rate removed when attacking with elemental disadvantage (default 0.15). */
  criticalRatePenaltyOnElementDisadvantage?: number;
  /** Chance that a non-critical, non-glancing hit with elemental advantage becomes a crushing hit (default 1). */
  crushingChanceOnElementAdvantage?: number;
  /** Damage multiplier of a crushing hit (default 1.3). */
  crushingDamageMultiplier?: number;
  /** Destroy effects remove at most this fraction of a unit's original max HP over a battle (default 0.6). */
  destroyMaxHpCap?: number;
};

export type CombatHealingFormula = {
  minimumHeal: number;
};

export type CombatReviveFormula = {
  cleanseDebuffsOnRevive: boolean;
  shieldPercentOnRevive: number;
  turnBarPercentOnRevive: number;
};

export type CombatElementMatrix = {
  ids: string[];
  matrix: number[];
};

/** Default values used when a status is applied with an authored magnitude / percent of 0. */
export type CombatStatusDefault = {
  magnitude?: number;
  percentPerTurn?: number;
  maxStacks?: number;
};

export type CombatStatusDefaults = Partial<Record<StatusId, CombatStatusDefault>>;

export type CombatFormulaSnapshot = {
  version: string;
  timing: CombatTimingFormula;
  accuracy: CombatAccuracyFormula;
  damage: CombatDamageFormula;
  healing: CombatHealingFormula;
  revive: CombatReviveFormula;
  elements: CombatElementMatrix;
  /** Default magnitudes per status (optional; missing entries use the built-in defaults). */
  statusDefaults?: CombatStatusDefaults;
  /** Turn order system (optional; default `AttackBar`). */
  turnOrder?: Partial<CombatTurnOrderFormula>;
};

/** A formula snapshot where every optional field has been filled with its default. */
export type ResolvedCombatFormula = {
  version: string;
  timing: CombatTimingFormula;
  accuracy: Required<CombatAccuracyFormula>;
  damage: Required<CombatDamageFormula>;
  healing: CombatHealingFormula;
  revive: CombatReviveFormula;
  elements: CombatElementMatrix;
  statusDefaults: Record<string, Required<CombatStatusDefault>>;
  turnOrder: CombatTurnOrderFormula;
};

/**
 * Built-in status defaults. `magnitude` meaning per status:
 * stat buffs/debuffs = fraction of the base stat, Brand = extra damage taken, Glancing = extra glancing chance,
 * Counterattack = counter chance, ReflectDamage = reflected fraction, Shield = fraction of the caster's max HP,
 * Bomb = caster ATK multiplier. `percentPerTurn`: ContinuousDamage / HpRegen fraction of the bearer's max HP
 * per instance. `maxStacks`: instance cap of ContinuousDamage / Bomb.
 */
export const DEFAULT_STATUS_DEFAULTS: Readonly<Record<string, Required<CombatStatusDefault>>> = Object.freeze({
  AttackUp: { magnitude: 0.5, percentPerTurn: 0, maxStacks: 1 },
  DefenseUp: { magnitude: 0.7, percentPerTurn: 0, maxStacks: 1 },
  SpeedUp: { magnitude: 0.3, percentPerTurn: 0, maxStacks: 1 },
  CritRateUp: { magnitude: 0.3, percentPerTurn: 0, maxStacks: 1 },
  CritDamageUp: { magnitude: 0.3, percentPerTurn: 0, maxStacks: 1 },
  AttackBreak: { magnitude: 0.5, percentPerTurn: 0, maxStacks: 1 },
  DefenseBreak: { magnitude: 0.7, percentPerTurn: 0, maxStacks: 1 },
  Slow: { magnitude: 0.3, percentPerTurn: 0, maxStacks: 1 },
  Brand: { magnitude: 0.25, percentPerTurn: 0, maxStacks: 1 },
  Glancing: { magnitude: 0.5, percentPerTurn: 0, maxStacks: 1 },
  ContinuousDamage: { magnitude: 0, percentPerTurn: 0.05, maxStacks: 10 },
  HpRegen: { magnitude: 0, percentPerTurn: 0.15, maxStacks: 1 },
  Counterattack: { magnitude: 1, percentPerTurn: 0, maxStacks: 1 },
  ReflectDamage: { magnitude: 0.3, percentPerTurn: 0, maxStacks: 1 },
  Shield: { magnitude: 0.15, percentPerTurn: 0, maxStacks: 1 },
  Bomb: { magnitude: 1.5, percentPerTurn: 0, maxStacks: 5 },
  DamageReduction: { magnitude: 0.3, percentPerTurn: 0, maxStacks: 1 },
  CritResistUp: { magnitude: 0.5, percentPerTurn: 0, maxStacks: 1 },
});

const EMPTY_STATUS_DEFAULT: Required<CombatStatusDefault> = Object.freeze({ magnitude: 0, percentPerTurn: 0, maxStacks: 1 });

export function createDefaultCombatFormulaSnapshot(): CombatFormulaSnapshot {
  const statusDefaults: CombatStatusDefaults = {};
  for (const key of Object.keys(DEFAULT_STATUS_DEFAULTS)) {
    statusDefaults[key as StatusId] = { ...DEFAULT_STATUS_DEFAULTS[key] };
  }

  return {
    version: "1.0",
    timing: {
      defaultTurnThreshold: 1000,
      turnBarHeadroomMultiplier: 1.2,
    },
    accuracy: {
      baseHitChance: 1,
      accuracyVsEvasionWeight: 1,
      minimumHitChance: 0,
      maximumHitChance: 1,
      accuracyVsResistanceWeight: 1,
      minimumDebuffChance: 0,
      maximumDebuffChance: 1,
      debuffResistanceModel: "resist_floor",
      minimumResistChance: 0.15,
      maximumResistChance: 1,
    },
    damage: {
      minimumDamage: 1,
      defaultDefenseConstant: 100,
      useCriticalDamageStat: false,
      allowCriticalOnGlancing: false,
      glancingChanceOnElementDisadvantage: 0.5,
      glancingDamageMultiplier: 0.7,
      elementalAdvantageDamageMultiplier: 1,
      elementalDisadvantageDamageMultiplier: 1,
      elementalNeutralDamageMultiplier: 1,
      criticalRateBonusOnElementAdvantage: 0.15,
      criticalRatePenaltyOnElementDisadvantage: 0.15,
      crushingChanceOnElementAdvantage: 1,
      crushingDamageMultiplier: 1.3,
      destroyMaxHpCap: 0.6,
    },
    healing: {
      minimumHeal: 1,
    },
    revive: {
      cleanseDebuffsOnRevive: true,
      shieldPercentOnRevive: 0,
      turnBarPercentOnRevive: 0,
    },
    elements: {
      ids: [],
      matrix: [],
    },
    statusDefaults,
    turnOrder: { mode: "AttackBar", teamPhaseSkipThreshold: 0.5, roundModeTurnBarCap: 3 },
  };
}

function readNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function readBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function readObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && value.trim().length > 0) out.push(value.trim());
  }
  return out;
}

function readNumberArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  }
  return out;
}

/**
 * Normalizes a (possibly partial) combat formula JSON into a fully populated snapshot.
 * Every missing or invalid field receives its default. Used by the engine and intended to be used by the
 * server combat config catalog (`sanitizeCombatFormula`).
 */
export function normalizeCombatFormulaSnapshot(raw: unknown): ResolvedCombatFormula {
  const defaults = createDefaultCombatFormulaSnapshot();
  const source = readObject(raw);
  const timing = readObject(source.timing);
  const accuracy = readObject(source.accuracy);
  const damage = readObject(source.damage);
  const healing = readObject(source.healing);
  const revive = readObject(source.revive);
  const elements = readObject(source.elements);
  const statusDefaultsRaw = readObject(source.statusDefaults);
  const turnOrder = readObject(source.turnOrder);

  const statusDefaults: Record<string, Required<CombatStatusDefault>> = {};
  for (const key of Object.keys(DEFAULT_STATUS_DEFAULTS)) {
    statusDefaults[key] = { ...DEFAULT_STATUS_DEFAULTS[key] };
  }
  for (const key of Object.keys(statusDefaultsRaw)) {
    const entry = readObject(statusDefaultsRaw[key]);
    const base = statusDefaults[key] ?? EMPTY_STATUS_DEFAULT;
    statusDefaults[key] = {
      magnitude: Math.max(0, readNumber(entry.magnitude, base.magnitude)),
      percentPerTurn: Math.max(0, readNumber(entry.percentPerTurn, base.percentPerTurn)),
      maxStacks: Math.max(1, Math.floor(readNumber(entry.maxStacks, base.maxStacks))),
    };
  }

  const dAcc = defaults.accuracy as Required<CombatAccuracyFormula>;
  const dDmg = defaults.damage as Required<CombatDamageFormula>;

  return {
    version: typeof source.version === "string" ? source.version : defaults.version,
    timing: {
      defaultTurnThreshold: Math.max(1, readNumber(timing.defaultTurnThreshold, defaults.timing.defaultTurnThreshold)),
      turnBarHeadroomMultiplier: Math.max(1, readNumber(timing.turnBarHeadroomMultiplier, defaults.timing.turnBarHeadroomMultiplier)),
    },
    accuracy: {
      baseHitChance: readNumber(accuracy.baseHitChance, dAcc.baseHitChance),
      accuracyVsEvasionWeight: readNumber(accuracy.accuracyVsEvasionWeight, dAcc.accuracyVsEvasionWeight),
      minimumHitChance: readNumber(accuracy.minimumHitChance, dAcc.minimumHitChance),
      maximumHitChance: readNumber(accuracy.maximumHitChance, dAcc.maximumHitChance),
      accuracyVsResistanceWeight: readNumber(accuracy.accuracyVsResistanceWeight, dAcc.accuracyVsResistanceWeight),
      minimumDebuffChance: readNumber(accuracy.minimumDebuffChance, dAcc.minimumDebuffChance),
      maximumDebuffChance: readNumber(accuracy.maximumDebuffChance, dAcc.maximumDebuffChance),
      debuffResistanceModel: accuracy.debuffResistanceModel === "linear" ? "linear" : "resist_floor",
      minimumResistChance: readNumber(accuracy.minimumResistChance, dAcc.minimumResistChance),
      maximumResistChance: readNumber(accuracy.maximumResistChance, dAcc.maximumResistChance),
    },
    damage: {
      minimumDamage: Math.max(0, Math.floor(readNumber(damage.minimumDamage, dDmg.minimumDamage))),
      defaultDefenseConstant: Math.max(0, readNumber(damage.defaultDefenseConstant, dDmg.defaultDefenseConstant)),
      useCriticalDamageStat: readBoolean(damage.useCriticalDamageStat, dDmg.useCriticalDamageStat),
      allowCriticalOnGlancing: readBoolean(damage.allowCriticalOnGlancing, dDmg.allowCriticalOnGlancing),
      glancingChanceOnElementDisadvantage: readNumber(damage.glancingChanceOnElementDisadvantage, dDmg.glancingChanceOnElementDisadvantage),
      glancingDamageMultiplier: readNumber(damage.glancingDamageMultiplier, dDmg.glancingDamageMultiplier),
      elementalAdvantageDamageMultiplier: readNumber(damage.elementalAdvantageDamageMultiplier, dDmg.elementalAdvantageDamageMultiplier),
      elementalDisadvantageDamageMultiplier: readNumber(damage.elementalDisadvantageDamageMultiplier, dDmg.elementalDisadvantageDamageMultiplier),
      elementalNeutralDamageMultiplier: readNumber(damage.elementalNeutralDamageMultiplier, dDmg.elementalNeutralDamageMultiplier),
      criticalRateBonusOnElementAdvantage: readNumber(damage.criticalRateBonusOnElementAdvantage, dDmg.criticalRateBonusOnElementAdvantage),
      criticalRatePenaltyOnElementDisadvantage: readNumber(damage.criticalRatePenaltyOnElementDisadvantage, dDmg.criticalRatePenaltyOnElementDisadvantage),
      crushingChanceOnElementAdvantage: readNumber(damage.crushingChanceOnElementAdvantage, dDmg.crushingChanceOnElementAdvantage),
      crushingDamageMultiplier: readNumber(damage.crushingDamageMultiplier, dDmg.crushingDamageMultiplier),
      destroyMaxHpCap: Math.min(1, Math.max(0, readNumber(damage.destroyMaxHpCap, dDmg.destroyMaxHpCap))),
    },
    healing: {
      minimumHeal: Math.max(0, Math.floor(readNumber(healing.minimumHeal, defaults.healing.minimumHeal))),
    },
    revive: {
      cleanseDebuffsOnRevive: readBoolean(revive.cleanseDebuffsOnRevive, defaults.revive.cleanseDebuffsOnRevive),
      shieldPercentOnRevive: readNumber(revive.shieldPercentOnRevive, defaults.revive.shieldPercentOnRevive),
      turnBarPercentOnRevive: readNumber(revive.turnBarPercentOnRevive, defaults.revive.turnBarPercentOnRevive),
    },
    elements: {
      ids: readStringArray(elements.ids),
      matrix: readNumberArray(elements.matrix),
    },
    statusDefaults,
    turnOrder: {
      mode: readTurnOrderMode(turnOrder.mode),
      teamPhaseSkipThreshold: Math.min(2, Math.max(0, readNumber(turnOrder.teamPhaseSkipThreshold, 0.5))),
      roundModeTurnBarCap: Math.min(10, Math.max(1, readNumber(turnOrder.roundModeTurnBarCap, 3))),
    },
  };
}

/** Turn order mode from config JSON (unknown values = `AttackBar`). */
export function readTurnOrderMode(raw: unknown): TurnOrderMode {
  return typeof raw === "string" && (TURN_ORDER_MODES as readonly string[]).includes(raw) ? raw as TurnOrderMode : "AttackBar";
}

const resolvedCache = new WeakMap<object, ResolvedCombatFormula>();

/** Returns the resolved (fully populated) form of a snapshot. Results are cached per snapshot object. */
export function resolveCombatFormula(
  snapshot: CombatFormulaSnapshot | ResolvedCombatFormula | null | undefined
): ResolvedCombatFormula {
  if (!snapshot) return normalizeCombatFormulaSnapshot(null);
  const cached = resolvedCache.get(snapshot);
  if (cached) return cached;
  const resolved = normalizeCombatFormulaSnapshot(snapshot);
  resolvedCache.set(snapshot, resolved);
  resolvedCache.set(resolved, resolved);
  return resolved;
}

/** Status default for a status id (zeros when the status has no default). */
export function getStatusDefault(formulas: ResolvedCombatFormula, status: string): Required<CombatStatusDefault> {
  return formulas.statusDefaults[status] ?? DEFAULT_STATUS_DEFAULTS[status] ?? EMPTY_STATUS_DEFAULT;
}

function normalizeElementToken(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function defaultCompareElements(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 {
  const aa = normalizeElementToken(a);
  const bb = normalizeElementToken(b);
  if (!aa || !bb || aa === bb) return 0;

  const isFire = (value: string) => value.includes("fire");
  const isWater = (value: string) => value.includes("water");
  const isWind = (value: string) => value.includes("wind");
  const isLight = (value: string) => value.includes("light");
  const isDark = (value: string) => value.includes("dark");

  if (isFire(aa) && isWind(bb)) return 1;
  if (isWind(aa) && isWater(bb)) return 1;
  if (isWater(aa) && isFire(bb)) return 1;

  if (isWind(aa) && isFire(bb)) return -1;
  if (isWater(aa) && isWind(bb)) return -1;
  if (isFire(aa) && isWater(bb)) return -1;

  if ((isLight(aa) && isDark(bb)) || (isDark(aa) && isLight(bb))) return 1;
  return 0;
}

/** Element relation of attacker vs defender: 1 = advantage, -1 = disadvantage, 0 = neutral. */
export function compareElements(
  formulas: Pick<CombatFormulaSnapshot, "elements">,
  attackerElementId: string | null | undefined,
  defenderElementId: string | null | undefined
): -1 | 0 | 1 {
  const ids = formulas.elements.ids;
  const matrix = formulas.elements.matrix;

  if (ids.length > 0 && matrix.length >= ids.length * ids.length) {
    const attackerIndex = ids.indexOf(attackerElementId ?? "");
    const defenderIndex = ids.indexOf(defenderElementId ?? "");

    if (attackerIndex >= 0 && defenderIndex >= 0) {
      const raw = matrix[(attackerIndex * ids.length) + defenderIndex] ?? 0;
      return raw < 0 ? -1 : raw > 0 ? 1 : 0;
    }
  }

  return defaultCompareElements(attackerElementId, defenderElementId);
}
