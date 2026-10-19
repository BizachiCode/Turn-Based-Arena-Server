import { getBattleUnit, listAliveEnemyUnits, listUnitsBySide } from "../domain/battle-state-utils";
import type { BattleRandom } from "../domain/battle-random";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import type { CharacterSkillDTO, SkillEffectDTO } from "../types/battle-data";
import { normalizeTargetingMode } from "../types/battle-data";
import { getEffectTargetScope, isCasterEffect, skillCanTargetDeadAllies } from "../skills/skill-rules";

export function resolvePrimaryTarget(
  state: BattleState,
  targetId: string
): BattleUnitState | undefined {
  return getBattleUnit(state, targetId);
}

function pickRandomIndex(length: number, rng: BattleRandom | null | undefined): number {
  if (length <= 1 || !rng) return 0;
  const rolled = Math.floor(rng.next() * length);
  return Math.max(0, Math.min(length - 1, rolled));
}

/** Picks up to `count` distinct units (without replacement) using the battle RNG. */
export function pickRandomUnits(units: BattleUnitState[], count: number, rng: BattleRandom | null | undefined): BattleUnitState[] {
  const pool = [...units];
  const picked: BattleUnitState[] = [];
  const wanted = Math.max(0, Math.floor(count));
  while (picked.length < wanted && pool.length > 0) {
    const index = pickRandomIndex(pool.length, rng);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

function sideTargets(state: BattleState, sideId: string, includeDead: boolean): BattleUnitState[] {
  return listUnitsBySide(state, sideId).filter((unit) => unit.currentHp > 0 || includeDead);
}

/**
 * Resolves the targets of a skill from its targeting mode. Dead units are only included for skills that
 * revive through their skill targets. `RandomEnemies` consumes RNG (resolve once per skill use).
 */
export function resolveSkillTargets(
  state: BattleState,
  actor: BattleUnitState,
  primaryTarget: BattleUnitState,
  skill: CharacterSkillDTO,
  rng?: BattleRandom | null
): BattleUnitState[] {
  const includeDead = skillCanTargetDeadAllies(skill);

  switch (normalizeTargetingMode(skill.targeting) ?? "SingleTarget") {
    case "CircleAroundTarget":
    case "LineFromTarget":
      return sideTargets(state, primaryTarget.sideId, includeDead && primaryTarget.sideId === actor.sideId);

    case "AllEnemies":
      return listAliveEnemyUnits(state, actor.sideId);

    case "AllAllies":
      return sideTargets(state, actor.sideId, includeDead);

    case "RandomEnemies": {
      const count = Math.max(1, Math.floor(Number(skill.randomTargetCount ?? 1) || 1));
      return pickRandomUnits(listAliveEnemyUnits(state, actor.sideId), count, rng);
    }

    case "SingleTarget":
    default:
      return (primaryTarget.currentHp > 0 || includeDead) ? [primaryTarget] : [];
  }
}

function hpRatio(unit: BattleUnitState): number {
  return unit.maxHp > 0 ? unit.currentHp / unit.maxHp : 0;
}

/** Alive ally with the lowest HP ratio (ties: lowest current HP, then canonical order). */
export function findLowestHpAlly(state: BattleState, actor: BattleUnitState): BattleUnitState | null {
  let best: BattleUnitState | null = null;
  for (const unit of listUnitsBySide(state, actor.sideId)) {
    if (unit.currentHp <= 0) continue;
    if (!best) {
      best = unit;
      continue;
    }
    const ratioDiff = hpRatio(unit) - hpRatio(best);
    if (ratioDiff < 0 || (ratioDiff === 0 && unit.currentHp < best.currentHp)) best = unit;
  }
  return best;
}

/**
 * Resolves the targets of one effect from its `target` scope (before alive/dead filtering). Caster effects
 * (ExtraTurn, AdditionalAttack, AllyAttack) always resolve to the caster.
 */
export function resolveEffectScopeTargets(
  state: BattleState,
  actor: BattleUnitState,
  primaryTarget: BattleUnitState,
  skillTargets: BattleUnitState[],
  effect: SkillEffectDTO,
  rng?: BattleRandom | null
): BattleUnitState[] {
  if (isCasterEffect(effect)) return [actor];
  switch (getEffectTargetScope(effect)) {
    case "Self":
      return [actor];

    case "PrimaryTarget":
      return [primaryTarget];

    case "AllAllies":
      return sideTargets(state, actor.sideId, effect.type === "Revive");

    case "AllEnemies":
      return listAliveEnemyUnits(state, actor.sideId);

    case "LowestHpAlly": {
      const lowest = findLowestHpAlly(state, actor);
      return lowest ? [lowest] : [];
    }

    case "RandomEnemy":
      return pickRandomUnits(listAliveEnemyUnits(state, actor.sideId), 1, rng);

    case "SkillTargets":
    default:
      return skillTargets;
  }
}

/** Revive only affects dead units; every other effect only affects living units. */
export function filterTargetsForEffect(effect: SkillEffectDTO, targets: BattleUnitState[]): BattleUnitState[] {
  return effect.type === "Revive"
    ? targets.filter((unit) => unit.currentHp <= 0)
    : targets.filter((unit) => unit.currentHp > 0);
}
