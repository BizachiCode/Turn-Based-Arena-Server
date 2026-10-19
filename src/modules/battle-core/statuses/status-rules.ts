import { StatusId, canonicalStatusId } from "../types/battle-data";
import { DEFAULT_STATUS_DEFAULTS } from "../domain/combat-formula";
import { BattleActiveStatus, BattleStatusState, BattleStatusSummary } from "./status-models";

/**
 * Inherent polarity of a status (every status is either a beneficial or a harmful effect).
 * The engine always uses this polarity; the authored `isBuff` flag of a skill effect is informational.
 */
export function defaultIsBuff(status: StatusId): boolean {
  switch (canonicalStatusId(status)) {
    case "AttackUp":
    case "DefenseUp":
    case "Shield":
    case "Immunity":
    case "Invincibility":
    case "Endure":
    case "SpeedUp":
    case "CritRateUp":
    case "CritDamageUp":
    case "Counterattack":
    case "ReflectDamage":
    case "HpRegen":
    case "DamageReduction":
    case "CritResistUp":
    case "Threat":
    case "Berserk":
    case "InabilityImmunity":
      return true;

    default:
      return false;
  }
}

/** Hard crowd control: the bearer skips its turn (durations still tick). Provoke is NOT hard control. */
export function isHardControlStatus(status: StatusId): boolean {
  switch (status) {
    case "Stun":
    case "Freeze":
    case "Sleep":
      return true;

    default:
      return false;
  }
}

/** Statuses removed when the bearer takes damage from a direct hit. */
export function breaksOnDamage(status: StatusId): boolean {
  return status === "Sleep";
}

export function isShieldStatus(status: StatusId): boolean {
  return status === "Shield";
}

/** Statuses that stay on a unit when it dies (every other status is cleared on death). */
export function survivesDeath(status: StatusId): boolean {
  return status === "Unrevivable";
}

/** Statuses where every application is an independent instance with its own duration (capped by maxStacks). */
export function isInstanceStackingStatus(status: StatusId): boolean {
  return status === "ContinuousDamage" || status === "Bomb";
}

export function isExpired(status: BattleActiveStatus): boolean {
  return status.remainingTurns <= 0;
}

/** Magnitude of an active status, falling back to the built-in default when authored as 0. */
export function getEffectiveStatusMagnitude(active: BattleActiveStatus): number {
  if (active.magnitude > 0) return active.magnitude;
  const fallback = DEFAULT_STATUS_DEFAULTS[active.status];
  return fallback ? fallback.magnitude : 0;
}

/** True when the status is ignored because it was granted by the bearer's own passive while the bearer has Oblivion. */
export function isSuppressedByOblivion(state: BattleStatusState, active: BattleActiveStatus, passivesSealed: boolean): boolean {
  return passivesSealed && !!active.passiveId && active.sourceId === state.unitId;
}

export function hasActiveStatus(state: BattleStatusState, status: StatusId): boolean {
  const wanted = canonicalStatusId(status);
  for (const active of state.statuses) {
    if (canonicalStatusId(active.status) === wanted && !isExpired(active)) return true;
  }
  return false;
}

/** Number of active harmful (`beneficial = false`) or beneficial status instances on a unit. */
export function countActiveStatuses(state: BattleStatusState, beneficial: boolean): number {
  let count = 0;
  for (const active of Array.isArray(state.statuses) ? state.statuses : []) {
    if (active && !isExpired(active) && active.isBuff === beneficial) count += 1;
  }
  return count;
}

export function buildStatusSummary(state: BattleStatusState): BattleStatusSummary {
  const summary: BattleStatusSummary = {
    cannotAct: false,
    cannotUseSkills: false,
    invulnerable: false,
    debuffImmune: false,
    buffBlocked: false,
    healBlocked: false,
    hasEndure: false,
    forcedTargetId: null,
    passivesSealed: false,
    attackModifier: 0,
    defenseModifier: 0,
    speedModifier: 0,
    critRateBonus: 0,
    critDamageBonus: 0,
    incomingDamageMultiplier: 1,
    glancingChanceBonus: 0,
    counterattackChance: 0,
    reflectDamagePercent: 0,
    critResistBonus: 0,
    hasThreat: false,
    unrevivable: false,
    turnBarIncreaseBlocked: false,
    hardControlImmune: false,
  };

  const statuses = Array.isArray(state.statuses) ? state.statuses : [];
  summary.passivesSealed = hasActiveStatus(state, "Oblivion");

  for (const active of statuses) {
    if (!active || isExpired(active)) continue;
    if (isSuppressedByOblivion(state, active, summary.passivesSealed)) continue;

    const magnitude = Math.max(0, getEffectiveStatusMagnitude(active));

    switch (canonicalStatusId(active.status)) {
      case "Stun":
      case "Sleep":
        summary.cannotAct = true;
        break;

      case "Freeze":
        summary.cannotAct = true;
        summary.turnBarIncreaseBlocked = true;
        break;

      case "Provoke":
        if (active.sourceId && !summary.forcedTargetId) summary.forcedTargetId = active.sourceId;
        break;

      case "Silence":
        summary.cannotUseSkills = true;
        break;

      case "Invincibility":
        summary.invulnerable = true;
        break;

      case "Immunity":
        summary.debuffImmune = true;
        break;

      case "BeneficialBlock":
        summary.buffBlocked = true;
        break;

      case "HealBlock":
        summary.healBlocked = true;
        break;

      case "Endure":
        summary.hasEndure = true;
        break;

      case "AttackUp":
        summary.attackModifier += magnitude;
        break;

      case "AttackBreak":
        summary.attackModifier -= magnitude;
        break;

      case "DefenseUp":
        summary.defenseModifier += magnitude;
        break;

      case "DefenseBreak":
        summary.defenseModifier -= magnitude;
        break;

      case "SpeedUp":
        summary.speedModifier += magnitude;
        break;

      case "Slow":
        summary.speedModifier -= magnitude;
        break;

      case "CritRateUp":
        summary.critRateBonus += magnitude;
        break;

      case "CritDamageUp":
        summary.critDamageBonus += magnitude;
        break;

      case "Brand":
        summary.incomingDamageMultiplier *= 1 + magnitude;
        break;

      case "Glancing":
        summary.glancingChanceBonus += magnitude;
        break;

      case "Counterattack":
        summary.counterattackChance += magnitude;
        break;

      case "ReflectDamage":
        summary.reflectDamagePercent += magnitude;
        break;

      case "DamageReduction":
        summary.incomingDamageMultiplier *= Math.max(0, 1 - magnitude);
        break;

      case "CritResistUp":
        summary.critResistBonus += magnitude;
        break;

      case "Threat":
        summary.hasThreat = true;
        break;

      case "Unrevivable":
        summary.unrevivable = true;
        break;

      case "Berserk":
        // magnitude = ATK bonus, value = SPD bonus (both resolved from the AttackUp / SpeedUp defaults at application).
        summary.attackModifier += magnitude;
        summary.speedModifier += Math.max(0, active.value ?? magnitude);
        break;

      case "InabilityImmunity":
        summary.hardControlImmune = true;
        break;
    }
  }

  return summary;
}
