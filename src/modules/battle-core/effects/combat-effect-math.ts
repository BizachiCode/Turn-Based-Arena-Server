import {
  compareElements,
  resolveCombatFormula,
  type CombatFormulaSnapshot,
  type ResolvedCombatFormula,
} from "../domain/combat-formula";
import type { BattleUnitState } from "../domain/battle-state";
import { buildStatusSummary, countActiveStatuses } from "../statuses/status-rules";
import type { SkillEffectDTO, StatTermDTO, StatTermSource } from "../types/battle-data";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** Rolls a chance: >= 1 always succeeds and <= 0 always fails without consuming RNG; otherwise one roll. */
export function rollChance(chance: number, rng: () => number): boolean {
  if (!(chance > 0)) return false;
  if (chance >= 1) return true;
  return rng() < chance;
}

export type EffectiveStatKey = "atk" | "def" | "spd";

/**
 * Effective ATK / DEF / SPD: `stat + baseStat * modifier` where modifier is the sum of buffs minus debuffs
 * (buffs scale from the base stat). Never below 0.
 */
export function getEffectiveStat(unit: BattleUnitState, key: EffectiveStatKey): number {
  const summary = buildStatusSummary(unit);
  const modifier = key === "atk" ? summary.attackModifier : key === "def" ? summary.defenseModifier : summary.speedModifier;
  const base = finiteOr(unit.baseStats?.[key], unit.stats[key]);
  return Math.max(0, unit.stats[key] + (base * modifier));
}

/**
 * Value of a stat term for `unit`. `TargetMaxHP` / `TargetSpeed` read `target` (the unit hit; heals read the unit
 * itself).
 */
export function readBattleStat(unit: BattleUnitState, source: StatTermSource, target: BattleUnitState = unit): number {
  switch (source) {
    case "TargetMaxHP":
      return target.maxHp;

    case "TargetSpeed":
      return getEffectiveStat(target, "spd");

    case "Attack":
      return getEffectiveStat(unit, "atk");

    case "Defense":
      return getEffectiveStat(unit, "def");

    case "Speed":
      return getEffectiveStat(unit, "spd");

    case "MaxHP":
    default:
      return unit.maxHp;
  }
}

/** Hit roll: `clamp(baseHitChance + (ACC - EVA) * weight, min, max)`. */
export function rollHit(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  attacker: BattleUnitState,
  defender: BattleUnitState,
  rng: () => number
): boolean {
  const chance = clamp(
    formulas.accuracy.baseHitChance + ((attacker.stats.acc - defender.stats.eva) * formulas.accuracy.accuracyVsEvasionWeight),
    formulas.accuracy.minimumHitChance,
    formulas.accuracy.maximumHitChance
  );

  return rollChance(chance, rng);
}

/** Glancing chance: attacker Glancing debuff + disadvantage chance (50%). */
export function getGlancingChance(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  attacker: BattleUnitState,
  elementRelation: number
): number {
  let chance = Math.max(0, buildStatusSummary(attacker).glancingChanceBonus);
  if (elementRelation < 0) chance += Math.max(0, formulas.damage.glancingChanceOnElementDisadvantage);
  return clamp01(chance);
}

export function rollGlancing(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  attacker: BattleUnitState,
  defender: BattleUnitState,
  rng: () => number,
  elementRelation?: number
): boolean {
  const relation = elementRelation ?? compareElements(formulas, attacker.elementId, defender.elementId);
  return rollChance(getGlancingChance(formulas, attacker, relation), rng);
}

/**
 * Crit chance: CR + CritRateUp, +15% with advantage, -15% with disadvantage (configurable), minus the defender's
 * CritResistUp.
 */
export function getCriticalChance(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  attacker: BattleUnitState,
  elementRelation: number,
  defender?: BattleUnitState | null
): number {
  const resolved = resolveCombatFormula(formulas);
  let chance = attacker.stats.cr + buildStatusSummary(attacker).critRateBonus;
  if (elementRelation > 0) chance += resolved.damage.criticalRateBonusOnElementAdvantage;
  else if (elementRelation < 0) chance -= resolved.damage.criticalRatePenaltyOnElementDisadvantage;
  if (defender) chance -= buildStatusSummary(defender).critResistBonus;
  return clamp01(chance);
}

/** Critical roll; `guaranteed` (effect `guaranteedCrit`) makes every non-glancing hit critical without a roll. */
export function rollCritical(
  attacker: BattleUnitState,
  isGlancing: boolean,
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  rng: () => number,
  elementRelation: number = 0,
  defender?: BattleUnitState | null,
  guaranteed: boolean = false
): boolean {
  if (isGlancing && !formulas.damage.allowCriticalOnGlancing) return false;
  if (guaranteed) return true;
  return rollChance(getCriticalChance(formulas, attacker, elementRelation, defender), rng);
}

/** Crushing hit: non-critical, non-glancing hit with elemental advantage (default chance 100%). */
export function rollCrushing(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  elementRelation: number,
  isCritical: boolean,
  isGlancing: boolean,
  rng: () => number
): boolean {
  if (elementRelation <= 0 || isCritical || isGlancing) return false;
  return rollChance(resolveCombatFormula(formulas).damage.crushingChanceOnElementAdvantage, rng);
}

/**
 * Defense factor `C / (C + DEF * (1 - ignoreDefense))` with the effect's defense constant (or the formula default).
 */
export function computeDefenseFactor(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  defender: BattleUnitState,
  defenseConstant: number,
  ignoreDefense: number = 0
): number {
  const effectiveDefense = getEffectiveStat(defender, "def") * (1 - clamp01(finiteOr(ignoreDefense, 0)));
  const constant = defenseConstant > 0 ? defenseConstant : formulas.damage.defaultDefenseConstant;
  return constant <= 0 ? 1 : constant / (constant + effectiveDefense);
}

function hpRatio(unit: BattleUnitState): number {
  return unit.maxHp > 0 ? clamp01(unit.currentHp / unit.maxHp) : 0;
}

/**
 * Damage scaling multiplier of an effect for one hit (`scaling` x `scalingAmount`): HP ratios of the target / caster,
 * harmful effects on the target, beneficial effects on the caster, or the caster's effective speed / 100.
 */
export function computeDamageScalingMultiplier(effect: SkillEffectDTO, attacker: BattleUnitState, defender: BattleUnitState): number {
  const amount = finiteOr(effect.scalingAmount, 0);
  switch (effect.scaling ?? "None") {
    case "TargetHpLow": return 1 + amount * (1 - hpRatio(defender));
    case "TargetHpHigh": return 1 + amount * hpRatio(defender);
    case "CasterHpLow": return 1 + amount * (1 - hpRatio(attacker));
    case "CasterHpHigh": return 1 + amount * hpRatio(attacker);
    case "TargetDebuffCount": return 1 + amount * countActiveStatuses(defender, false);
    case "CasterBuffCount": return 1 + amount * countActiveStatuses(attacker, true);
    case "CasterSpeed": return 1 + amount * getEffectiveStat(attacker, "spd") / 100;
    default: return 1;
  }
}

/** Per-effect damage modifiers (effect fields resolved by the damage handler). */
export type DamageModifiers = {
  /** Fraction of the defender's DEF ignored. */
  ignoreDefense?: number;
  /** Added to the critical multiplier. */
  critDamageBonus?: number;
  /** Scaling multiplier applied before defense (`computeDamageScalingMultiplier`). */
  scalingMultiplier?: number;
};

/**
 * Damage of one hit: (sum of stat terms + flat) * scaling * defense factor * Brand / DamageReduction * element
 * multiplier * glancing * crushing * critical, rounded (JS Math.round), at least `minimumDamage`.
 */
export function computeDamageFromTerms(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  attacker: BattleUnitState,
  defender: BattleUnitState,
  damageTerms: StatTermDTO[],
  flatDamageBonus: number,
  defenseConstant: number,
  critMultiplier: number,
  isCritical: boolean,
  isGlancing: boolean,
  isCrushing: boolean = false,
  elementRelation?: number,
  modifiers?: DamageModifiers
): number {
  const resolved = resolveCombatFormula(formulas);
  const attackerSummary = buildStatusSummary(attacker);
  const defenderSummary = buildStatusSummary(defender);

  let amount = 0;
  for (const term of Array.isArray(damageTerms) ? damageTerms : []) {
    amount += readBattleStat(attacker, term.source, defender) * finiteOr(term.multiplier, 0);
  }
  amount += finiteOr(flatDamageBonus, 0);
  amount *= finiteOr(modifiers?.scalingMultiplier, 1);

  amount *= computeDefenseFactor(resolved, defender, finiteOr(defenseConstant, 0), finiteOr(modifiers?.ignoreDefense, 0));
  amount *= defenderSummary.incomingDamageMultiplier;

  const relation = elementRelation ?? compareElements(resolved, attacker.elementId, defender.elementId);
  if (relation > 0) amount *= resolved.damage.elementalAdvantageDamageMultiplier;
  else if (relation < 0) amount *= resolved.damage.elementalDisadvantageDamageMultiplier;
  else amount *= resolved.damage.elementalNeutralDamageMultiplier;

  if (isGlancing) amount *= resolved.damage.glancingDamageMultiplier;
  if (isCrushing) amount *= resolved.damage.crushingDamageMultiplier;

  if (isCritical) {
    const bonus = attackerSummary.critDamageBonus + finiteOr(modifiers?.critDamageBonus, 0);
    const criticalValue = resolved.damage.useCriticalDamageStat
      ? Math.max(1, attacker.stats.cd + bonus)
      : Math.max(1, finiteOr(critMultiplier, 1.5) + bonus);
    amount *= criticalValue;
  }

  return Math.max(resolved.damage.minimumDamage, Math.round(amount));
}

export function computeHealAmount(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  source: BattleUnitState,
  target: BattleUnitState,
  healFromSource: boolean,
  healStat: StatTermSource,
  healScale: number,
  flatHealBonus: number
): number {
  const basisUnit = healFromSource ? source : target;
  const amount = (readBattleStat(basisUnit, healStat ?? "MaxHP") * finiteOr(healScale, 0)) + finiteOr(flatHealBonus, 0);
  return Math.max(formulas.healing.minimumHeal, Math.round(amount));
}

/** Shield absorb: magnitude > 1 is a flat amount, otherwise a fraction of the caster's max HP. */
export function computeShieldValue(caster: BattleUnitState, magnitude: number): number {
  if (magnitude > 1) return Math.max(0, Math.round(magnitude));
  return Math.max(0, Math.round(caster.maxHp * Math.max(0, magnitude)));
}

/**
 * Bomb damage snapshot at application: caster effective ATK * magnitude * target defense factor
 * (default defense constant), at least `minimumDamage`.
 */
export function computeBombValue(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula,
  caster: BattleUnitState,
  target: BattleUnitState,
  magnitude: number
): number {
  const resolved = resolveCombatFormula(formulas);
  const raw = getEffectiveStat(caster, "atk") * Math.max(0, magnitude) * computeDefenseFactor(resolved, target, 0);
  return Math.max(resolved.damage.minimumDamage, Math.round(raw));
}
