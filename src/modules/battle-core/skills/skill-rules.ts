import type { BattleState, BattleUnitState } from "../domain/battle-state";
import { getBattleUnit, getUnitLine, listUnitsBySide } from "../domain/battle-state-utils";
import { buildStatusSummary, defaultIsBuff } from "../statuses/status-rules";
import type {
  CharacterSkillDTO,
  EffectCondition,
  EffectTargetScope,
  SkillEffectDTO,
  SkillLevelBonusDTO,
} from "../types/battle-data";
import { normalizeEffectCondition, normalizeEffectTargetScope, normalizeSkillTargetSide, normalizeTargetingMode } from "../types/battle-data";

/** Resolved side of a skill's primary target. */
export type ResolvedSkillTargetSide = "Enemy" | "Ally" | "Self";

export type SkillValidationFailure =
  | "UNKNOWN_SKILL"
  | "SKILL_ON_COOLDOWN"
  | "SILENCED"
  | "PROVOKED"
  | "INVALID_TARGET"
  | "INVALID_TARGET_SIDE"
  | "TARGET_DEAD"
  | "TARGET_ALIVE"
  | "INVALID_TARGET_LINE"
  | "INVALID_TARGET_THREAT";

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

export function findUnitSkill(unit: BattleUnitState, skillId: string): CharacterSkillDTO | undefined {
  return unit.skills.find((entry) => entry.id === skillId);
}

/** Authoritative skill level of a unit (1..maxSkillLevel). Client-sent levels are never used. */
export function getUnitSkillLevel(unit: BattleUnitState, skill: CharacterSkillDTO): number {
  const raw = finiteOr(unit.skillLevels?.[skill.id], 1);
  const max = Math.max(1, Math.floor(finiteOr(skill.maxSkillLevel, 1)));
  return Math.max(1, Math.min(max, Math.floor(raw)));
}

/** Cooldown (turns) of a skill at a level; 0 when not authored. */
export function getSkillCooldownAtLevel(skill: CharacterSkillDTO, level: number): number {
  const levels = Array.isArray(skill.cooldownByLevel) ? skill.cooldownByLevel : [];
  if (levels.length === 0) return 0;
  const index = Math.max(0, Math.min(levels.length - 1, Math.floor(level) - 1));
  const raw = levels[index];
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
}

/** Cumulative skill-up bonus of a skill at a level (all 0 when not authored). */
export function getSkillLevelBonus(skill: CharacterSkillDTO, level: number): SkillLevelBonusDTO {
  const bonuses = Array.isArray(skill.levelBonuses) ? skill.levelBonuses : [];
  if (bonuses.length === 0) return { damagePct: 0, healPct: 0, effectChancePct: 0 };
  const bonus = bonuses[Math.max(0, Math.min(bonuses.length - 1, Math.floor(level) - 1))];
  return {
    damagePct: Math.max(0, finiteOr(bonus?.damagePct, 0)),
    healPct: Math.max(0, finiteOr(bonus?.healPct, 0)),
    effectChancePct: Math.max(0, finiteOr(bonus?.effectChancePct, 0)),
  };
}

/**
 * Effect as cast at a skill level: damage terms / flat damage scale by the damage bonus, heal scale / flat heal by the
 * recovery bonus, and chances below 100% gain the effect-chance bonus (capped at 100%). Returns the same object when
 * the level adds nothing.
 */
export function applySkillLevelToEffect(effect: SkillEffectDTO, bonus: SkillLevelBonusDTO): SkillEffectDTO {
  if (bonus.damagePct <= 0 && bonus.healPct <= 0 && bonus.effectChancePct <= 0) return effect;
  const damage = 1 + bonus.damagePct / 100;
  const heal = 1 + bonus.healPct / 100;
  const chance = bonus.effectChancePct / 100;
  const raise = (value: number) => {
    const base = finiteOr(value, 1);
    return base >= 1 ? base : Math.min(1, base + chance);
  };
  return {
    ...effect,
    damageTerms: (effect.damageTerms ?? []).map((term) => ({ ...term, multiplier: finiteOr(term.multiplier, 0) * damage })),
    flatDamageBonus: finiteOr(effect.flatDamageBonus, 0) * damage,
    healScale: finiteOr(effect.healScale, 0) * heal,
    flatHealBonus: finiteOr(effect.flatHealBonus, 0) * heal,
    baseChance: raise(effect.baseChance),
    applyChance: raise(effect.applyChance),
  };
}

/** Cooldown of a unit's skill at the unit's current skill level. */
export function getUnitSkillCooldown(unit: BattleUnitState, skill: CharacterSkillDTO): number {
  return getSkillCooldownAtLevel(skill, getUnitSkillLevel(unit, skill));
}

export function getEffectTargetScope(effect: SkillEffectDTO): EffectTargetScope {
  return normalizeEffectTargetScope(effect.target) ?? "SkillTargets";
}

export function getEffectCondition(effect: SkillEffectDTO): EffectCondition {
  return normalizeEffectCondition(effect.condition) ?? "Always";
}

/** Number of hits of a Damage effect (>= 1); 1 for every other effect type. */
export function getEffectHits(effect: SkillEffectDTO): number {
  if (effect.type !== "Damage") return 1;
  return Math.max(1, Math.floor(finiteOr(effect.hits, 1)));
}

/** Harmful effects: subject to resistance, immunity and the hit/glancing gating. */
export function isHarmfulEffect(effect: SkillEffectDTO): boolean {
  switch (effect.type) {
    case "Damage":
    case "Strip":
    case "StealBuffs":
    case "AbsorbTurnBar":
    case "TransferDebuffs":
      return true;
    case "ApplyStatus":
      return !defaultIsBuff(effect.status);
    case "TurnBar":
      return effect.turnBarIncrease === false;
    case "CooldownChange":
      return effect.cooldownIncrease !== false;
    case "ChangeStatusDuration":
      // Shortening buffs or extending debuffs.
      return effect.isBuff === (effect.cooldownIncrease === false);
    default:
      return false;
  }
}

/**
 * Effects that act on the caster's action (ExtraTurn, AdditionalAttack, AllyAttack): their target is always the
 * caster (scope ignored), so conditions are checked against the caster (OnHit / OnCrit / OnKill = any target).
 */
export function isCasterEffect(effect: SkillEffectDTO): boolean {
  return effect.type === "ExtraTurn" || effect.type === "AdditionalAttack" || effect.type === "AllyAttack";
}

export function isBeneficialEffect(effect: SkillEffectDTO): boolean {
  return !isHarmfulEffect(effect);
}

function isPrimaryScoped(effect: SkillEffectDTO): boolean {
  const scope = getEffectTargetScope(effect);
  return scope === "SkillTargets" || scope === "PrimaryTarget";
}

/** True when the skill revives through its skill targets (dead allies are valid primary targets). */
export function skillCanTargetDeadAllies(skill: CharacterSkillDTO): boolean {
  return (skill.effects ?? []).some((effect) => effect.type === "Revive" && isPrimaryScoped(effect));
}

/**
 * Side of the primary target. Explicit `targetSide` wins; `AllEnemies`/`RandomEnemies` imply Enemy and
 * `AllAllies` implies Ally; otherwise derived from the effects that use the skill targets
 * (Revive -> Ally, any harmful effect -> Enemy, else Ally), then from the other effects, then from the combat role.
 */
export function resolveSkillTargetSide(skill: CharacterSkillDTO): ResolvedSkillTargetSide {
  const explicit = normalizeSkillTargetSide(skill.targetSide);
  if (explicit && explicit !== "Auto") return explicit;

  const targeting = normalizeTargetingMode(skill.targeting) ?? "SingleTarget";
  if (targeting === "AllEnemies" || targeting === "RandomEnemies") return "Enemy";
  if (targeting === "AllAllies") return "Ally";

  const effects = Array.isArray(skill.effects) ? skill.effects : [];
  const primaryEffects = effects.filter(isPrimaryScoped);
  if (primaryEffects.length > 0) {
    if (primaryEffects.some((effect) => effect.type === "Revive")) return "Ally";
    if (primaryEffects.some(isHarmfulEffect)) return "Enemy";
    return "Ally";
  }

  if (effects.length > 0) {
    if (effects.every((effect) => getEffectTargetScope(effect) === "Self")) return "Self";
    const scopes = effects.map(getEffectTargetScope);
    if (scopes.includes("AllEnemies") || scopes.includes("RandomEnemy")) return "Enemy";
    return "Ally";
  }

  return skill.combatRole === "Support" || skill.combatRole === "Recovery" ? "Ally" : "Enemy";
}

/** Provoker id when the unit is provoked by a living unit, else null. */
export function getForcedTargetId(state: BattleState, unit: BattleUnitState): string | null {
  const forcedId = buildStatusSummary(unit).forcedTargetId;
  if (!forcedId) return null;
  const provoker = getBattleUnit(state, forcedId);
  return provoker && provoker.currentHp > 0 && provoker.sideId !== unit.sideId ? forcedId : null;
}

/** Why a skill cannot be used right now (null = usable). Order: cooldown, provoke, silence. */
export function getSkillUsabilityFailure(
  state: BattleState,
  unit: BattleUnitState,
  skill: CharacterSkillDTO
): SkillValidationFailure | null {
  if ((unit.cooldowns?.[skill.id] ?? 0) > 0) return "SKILL_ON_COOLDOWN";
  if (getForcedTargetId(state, unit) && unit.skills[0]?.id !== skill.id) return "PROVOKED";
  if (buildStatusSummary(unit).cannotUseSkills && getUnitSkillCooldown(unit, skill) > 0) return "SILENCED";
  return null;
}

export function listUsableSkills(state: BattleState, unit: BattleUnitState): CharacterSkillDTO[] {
  return unit.skills.filter((skill) => getSkillUsabilityFailure(state, unit, skill) === null);
}

/**
 * Line restriction: with `FrontlineOnly` / `BacklineOnly` the target must stand in that line while the target
 * side still has a living unit in it. Units without line information never block targeting.
 */
export function isTargetLineAllowed(state: BattleState, skill: CharacterSkillDTO, target: BattleUnitState): boolean {
  const allowed = skill.allowedLine ?? "Any";
  if (allowed !== "FrontlineOnly" && allowed !== "BacklineOnly") return true;

  const wanted = allowed === "FrontlineOnly" ? "Frontline" : "Backline";
  const sideHasLine = listUnitsBySide(state, target.sideId)
    .some((unit) => unit.currentHp > 0 && getUnitLine(unit) === wanted);
  if (!sideHasLine) return true;
  return getUnitLine(target) === wanted;
}

/** Living enemies of `actor` with Threat (canonical order). */
export function listThreatBearers(state: BattleState, actor: BattleUnitState): BattleUnitState[] {
  const out: BattleUnitState[] = [];
  for (const team of state.teams) {
    if (team.sideId === actor.sideId) continue;
    for (const unitId of team.unitIds) {
      const unit = getBattleUnit(state, unitId);
      if (unit && unit.currentHp > 0 && buildStatusSummary(unit).hasThreat) out.push(unit);
    }
  }
  return out;
}

/** True when Threat applies to the skill: single-target skills aimed at enemies. */
function isThreatBound(skill: CharacterSkillDTO, side: ResolvedSkillTargetSide): boolean {
  return side === "Enemy" && (normalizeTargetingMode(skill.targeting) ?? "SingleTarget") === "SingleTarget";
}

export type SkillTargetValidation =
  | { ok: true; primaryTarget: BattleUnitState }
  | { ok: false; reason: SkillValidationFailure };

/**
 * Validates the primary target of a skill: provoke (must target the provoker with skill 1), target side,
 * alive/dead (dead only for revive skills), Threat (single-target enemy skills must target a Threat bearer; the line
 * restriction does not apply then) and allowed line. `Self` skills always target the caster.
 */
export function validateSkillTarget(
  state: BattleState,
  actor: BattleUnitState,
  skill: CharacterSkillDTO,
  targetId: string
): SkillTargetValidation {
  const forcedId = getForcedTargetId(state, actor);
  if (forcedId) {
    if (targetId !== forcedId) return { ok: false, reason: "PROVOKED" };
    const provoker = getBattleUnit(state, forcedId);
    return provoker ? { ok: true, primaryTarget: provoker } : { ok: false, reason: "INVALID_TARGET" };
  }

  const side = resolveSkillTargetSide(skill);
  if (side === "Self") return { ok: true, primaryTarget: actor };

  const target = getBattleUnit(state, targetId);
  if (!target) return { ok: false, reason: "INVALID_TARGET" };

  if (side === "Enemy") {
    if (target.sideId === actor.sideId) return { ok: false, reason: "INVALID_TARGET_SIDE" };
    if (target.currentHp <= 0) return { ok: false, reason: "TARGET_DEAD" };
    if (isThreatBound(skill, side)) {
      const bearers = listThreatBearers(state, actor);
      if (bearers.length > 0) {
        return bearers.includes(target) ? { ok: true, primaryTarget: target } : { ok: false, reason: "INVALID_TARGET_THREAT" };
      }
    }
  } else {
    if (target.sideId !== actor.sideId) return { ok: false, reason: "INVALID_TARGET_SIDE" };
    if (target.currentHp <= 0 && !skillCanTargetDeadAllies(skill)) return { ok: false, reason: "TARGET_DEAD" };
  }

  if (!isTargetLineAllowed(state, skill, target)) return { ok: false, reason: "INVALID_TARGET_LINE" };
  return { ok: true, primaryTarget: target };
}

/** Every unit id that is a valid primary target for the skill (canonical order). */
export function listValidTargetIds(state: BattleState, actor: BattleUnitState, skill: CharacterSkillDTO): string[] {
  const forcedId = getForcedTargetId(state, actor);
  if (forcedId) return [forcedId];
  if (resolveSkillTargetSide(skill) === "Self") return [actor.unitId];

  const out: string[] = [];
  for (const team of state.teams) {
    for (const unitId of team.unitIds) {
      const validation = validateSkillTarget(state, actor, skill, unitId);
      if (validation.ok) out.push(unitId);
    }
  }
  return out;
}
