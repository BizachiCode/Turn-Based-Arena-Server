import type { BattleUnitState } from "../domain/battle-state";
import type { SkillEffectDTO } from "../types/battle-data";
import { countActiveStatuses, hasActiveStatus } from "../statuses/status-rules";
import { getEffectiveStat } from "../effects/combat-effect-math";
import { getEffectCondition, isCasterEffect, isHarmfulEffect } from "../skills/skill-rules";

/** Per-target hit bookkeeping for one skill resolution. */
export type SkillHitRecord = {
  /** Hits attempted against the target (including misses). */
  attempted: number;
  /** Hits that landed (not missed / not blocked by Invincibility), glancing included. */
  landed: number;
  /** Landed hits that were not glancing: only these can carry harmful effects . */
  harmfulLanded: number;
  /** Critical hits. */
  crits: number;
  /** Hits that killed the target. */
  kills: number;
};

/** Hit bookkeeping of one skill resolution, filled by Damage effects in effect order. */
export type SkillHitLedger = {
  byTarget: Record<string, SkillHitRecord>;
  hasDamage: boolean;
  totalLanded: number;
  totalCrits: number;
  totalKills: number;
};

export function createSkillHitLedger(): SkillHitLedger {
  return { byTarget: {}, hasDamage: false, totalLanded: 0, totalCrits: 0, totalKills: 0 };
}

export function ensureHitRecord(ledger: SkillHitLedger, unitId: string): SkillHitRecord {
  let record = ledger.byTarget[unitId];
  if (!record) {
    record = { attempted: 0, landed: 0, harmfulLanded: 0, crits: 0, kills: 0 };
    ledger.byTarget[unitId] = record;
  }
  return record;
}

function getRecord(ledger: SkillHitLedger, unitId: string): SkillHitRecord | null {
  return Object.prototype.hasOwnProperty.call(ledger.byTarget, unitId) ? ledger.byTarget[unitId] : null;
}

function hpRatioBelow(unit: BattleUnitState, threshold: number): boolean {
  return unit.maxHp > 0 && (unit.currentHp / unit.maxHp) < threshold;
}

/** Stat of `CasterStatHigher`: effective ATK / DEF / SPD, max HP or HP ratio. */
function conditionStatOf(unit: BattleUnitState, stat: string): number {
  switch (stat) {
    case "Defense": return getEffectiveStat(unit, "def");
    case "Speed": return getEffectiveStat(unit, "spd");
    case "MaxHP": return unit.maxHp;
    case "HpRatio": return unit.maxHp > 0 ? unit.currentHp / unit.maxHp : 0;
    default: return getEffectiveStat(unit, "atk");
  }
}

/**
 * Evaluates an effect condition for a target (the unit receiving the effect). OnHit / OnCrit use the target's own
 * record when it was attacked by this skill, otherwise the whole skill (e.g. a Self effect "on crit"); OnKill = a
 * previous Damage effect of the skill killed a unit; CasterHpBelow reads the caster. The "target" conditions
 * (TargetHpBelow, TargetHasDebuff / NoDebuff / NoBuff / Status, TargetIsNotBoss, the target of CasterStatHigher) read
 * the receiver when it is an enemy of the actor, and `conditionTarget` (the skill's primary target; passives: the
 * trigger's primary target / attacker) when the receiver is on the actor's own side ("if the enemy has no harmful
 * effect, your crit rate increases").
 */
export function isEffectConditionMet(
  effect: SkillEffectDTO,
  target: BattleUnitState,
  ledger: SkillHitLedger,
  actor: BattleUnitState,
  conditionTarget?: BattleUnitState | null
): boolean {
  const record = getRecord(ledger, target.unitId);
  const threshold = Number(effect.conditionValue ?? 0) || 0;
  const subject = target.sideId === actor.sideId && conditionTarget ? conditionTarget : target;
  switch (getEffectCondition(effect)) {
    case "OnHit":
      return record ? record.landed > 0 : ledger.totalLanded > 0;
    case "OnCrit":
      return record ? record.crits > 0 : ledger.totalCrits > 0;
    case "OnKill":
      return ledger.totalKills > 0;
    case "TargetHpBelow":
      return hpRatioBelow(subject, threshold);
    case "CasterHpBelow":
      return hpRatioBelow(actor, threshold);
    case "TargetHasDebuff":
      return countActiveStatuses(subject, false) > 0;
    case "TargetHasNoDebuff":
      return countActiveStatuses(subject, false) === 0;
    case "TargetHasNoBuff":
      return countActiveStatuses(subject, true) === 0;
    case "CasterHasStatus":
      return !!effect.conditionStatus && hasActiveStatus(actor, effect.conditionStatus);
    case "TargetHasStatus":
      return !!effect.conditionStatus && hasActiveStatus(subject, effect.conditionStatus);
    case "TargetIsNotBoss":
      return !subject.isBoss;
    case "CasterStatHigher": {
      const stat = effect.conditionStat ?? "Attack";
      return conditionStatOf(actor, stat) >= conditionStatOf(subject, stat) * threshold;
    }
    case "Always":
    default:
      return true;
  }
}

/**
 * How many times a non-damage effect applies to a target:
 * - harmful effect on an enemy that a previous Damage effect attacked: once per non-glancing landed hit with
 *   `applyEverySplit`, otherwise once if at least one such hit landed (0 = skipped);
 * - with `applyEverySplit` after a Damage effect: once per landed hit on that target (or per landed hit of the
 *   whole skill when the target was not attacked and the effect is beneficial);
 * - otherwise once.
 */
export function getEffectRepeatCount(
  effect: SkillEffectDTO,
  target: BattleUnitState,
  actor: BattleUnitState,
  ledger: SkillHitLedger
): number {
  if (effect.type === "Damage" || isCasterEffect(effect)) return 1;

  const record = getRecord(ledger, target.unitId);
  const harmfulOnEnemy = isHarmfulEffect(effect) && target.sideId !== actor.sideId;
  if (harmfulOnEnemy && record) {
    return effect.applyEverySplit ? record.harmfulLanded : Math.min(1, record.harmfulLanded);
  }

  if (!effect.applyEverySplit || !ledger.hasDamage) return 1;
  if (record) return record.landed;
  return harmfulOnEnemy ? 1 : ledger.totalLanded;
}
