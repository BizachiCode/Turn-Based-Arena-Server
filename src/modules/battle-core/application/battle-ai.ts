import type { BattleCommand } from "../domain/battle-command";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import { compareElements, type CombatFormulaSnapshot, type ResolvedCombatFormula } from "../domain/combat-formula";
import { getBattleUnit, listUnitsBySide } from "../domain/battle-state-utils";
import { buildStatusSummary, countActiveStatuses, isExpired } from "../statuses/status-rules";
import {
  getForcedTargetId,
  getUnitSkillCooldown,
  isBeneficialEffect,
  listUsableSkills,
  listValidTargetIds,
  resolveSkillTargetSide,
  skillCanTargetDeadAllies,
} from "../skills/skill-rules";
import type { CharacterSkillDTO, SkillEffectDTO } from "../types/battle-data";
import { normalizeTargetingMode } from "../types/battle-data";

export type BattleAiOptions = {
  /** Heal when an ally is below this HP ratio (default 0.5). */
  healThreshold?: number;
};

/** Why the AI picked a command (debugging / analytics). */
export type BattleAiDecisionKind = "provoked" | "revive" | "heal" | "cleanse" | "buff" | "attack" | "fallback" | "no_action";

export type BattleAiDecision = {
  command: BattleCommand;
  kind: BattleAiDecisionKind;
};

function hpRatio(unit: BattleUnitState): number {
  return unit.maxHp > 0 ? unit.currentHp / unit.maxHp : 0;
}

function hasHealEffect(skill: CharacterSkillDTO): boolean {
  return (skill.effects ?? []).some((effect) => effect.type === "Heal");
}

function hasCleanseEffect(skill: CharacterSkillDTO): boolean {
  return (skill.effects ?? []).some((effect) =>
    effect.type === "Cleanse");
}

function listBuffStatuses(skill: CharacterSkillDTO): string[] {
  const out: string[] = [];
  for (const effect of skill.effects ?? []) {
    if (effect.type === "ApplyStatus" && isBeneficialEffect(effect)) out.push(effect.status);
  }
  return out;
}

function isAreaSkill(skill: CharacterSkillDTO): boolean {
  const mode = normalizeTargetingMode(skill.targeting) ?? "SingleTarget";
  return mode !== "SingleTarget";
}

function countDispellableDebuffs(unit: BattleUnitState): number {
  let count = 0;
  for (const status of unit.statuses) {
    if (!status.isBuff && status.isDispellable && !isExpired(status)) count += 1;
  }
  return count;
}

function lacksAnyStatus(unit: BattleUnitState, statuses: string[]): boolean {
  return statuses.some((status) => !unit.statuses.some((active) => active.status === status && !isExpired(active)));
}

function effectsOf(skill: CharacterSkillDTO): SkillEffectDTO[] {
  return Array.isArray(skill.effects) ? skill.effects : [];
}

/**
 * Tempo value of a skill (valued like an ATB gain): ExtraTurn, AbsorbTurnBar, AdditionalAttack, AllyAttack or an
 * ATB increase on the caster.
 */
function tempoValue(skill: CharacterSkillDTO): number {
  return effectsOf(skill).some((effect) =>
    effect.type === "ExtraTurn"
    || effect.type === "AbsorbTurnBar"
    || effect.type === "AdditionalAttack"
    || effect.type === "AllyAttack"
    || (effect.type === "TurnBar" && effect.turnBarIncrease !== false && effect.target === "Self")) ? 1 : 0;
}

/**
 * Skill priority: higher cooldown first (bigger skills), then tempo skills (ExtraTurn, AbsorbTurnBar, ...), then later
 * skill slot first.
 */
function sortByPriority(actor: BattleUnitState, skills: CharacterSkillDTO[]): CharacterSkillDTO[] {
  return [...skills].sort((a, b) => {
    const cooldownDiff = getUnitSkillCooldown(actor, b) - getUnitSkillCooldown(actor, a);
    if (cooldownDiff !== 0) return cooldownDiff;
    const tempoDiff = tempoValue(b) - tempoValue(a);
    if (tempoDiff !== 0) return tempoDiff;
    return actor.skills.indexOf(b) - actor.skills.indexOf(a);
  });
}

/**
 * Target preference of an attack skill (higher = better), checked before the default element / HP order:
 * finishers (TargetHpLow scaling, IgnoreDefense, OnKill effects) prefer low HP ratios, TargetHpHigh scaling high HP
 * ratios, TargetDebuffCount scaling debuffed targets, AbsorbTurnBar full attack bars. Null = default order only.
 */
function targetPreference(skill: CharacterSkillDTO): ((unit: BattleUnitState) => number) | null {
  const effects = effectsOf(skill);
  if (effects.some((effect) => effect.type === "AbsorbTurnBar")) return (unit) => unit.turnBar;
  if (effects.some((effect) => effect.type === "Damage" && effect.scaling === "TargetDebuffCount")) return (unit) => countActiveStatuses(unit, false);
  if (effects.some((effect) => effect.type === "Damage" && effect.scaling === "TargetHpHigh")) return (unit) => hpRatio(unit);
  const finisher = effects.some((effect) =>
    (effect.type === "Damage" && (effect.scaling === "TargetHpLow" || (effect.ignoreDefense ?? 0) > 0))
    || effect.condition === "OnKill");
  return finisher ? (unit) => -hpRatio(unit) : null;
}

function useSkill(actor: BattleUnitState, skill: CharacterSkillDTO, targetId: string): BattleCommand {
  return { type: "use_skill", actorId: actor.unitId, skillId: skill.id, targetId };
}

function pickUnit(state: BattleState, ids: string[], better: (a: BattleUnitState, b: BattleUnitState) => boolean): string | null {
  let best: BattleUnitState | null = null;
  for (const id of ids) {
    const unit = getBattleUnit(state, id);
    if (!unit) continue;
    if (!best || better(unit, best)) best = unit;
  }
  return best?.unitId ?? null;
}

/**
 * Deterministic battle AI (used for enemies and player auto-play). Priority:
 * provoke > revive a dead ally (not Unrevivable) > heal when an ally is below the heal threshold > cleanse an ally
 * with debuffs > buff when a target lacks the buff > strongest ready attack (highest cooldown, then tempo skills) on
 * the best target (skill preference — see `targetPreference` —, elemental advantage, lowest HP ratio, lowest HP,
 * canonical order) > any usable skill > end turn. Threat / Provoke restrict the valid targets.
 */
export function decideAiCommand(
  state: BattleState,
  actorId: string,
  formulas: Pick<CombatFormulaSnapshot | ResolvedCombatFormula, "elements">,
  options?: BattleAiOptions
): BattleAiDecision {
  const actor = getBattleUnit(state, actorId);
  const noAction: BattleAiDecision = {
    command: { type: "end_turn", actorId, reason: "no_action" },
    kind: "no_action",
  };
  if (!actor || actor.currentHp <= 0) return noAction;

  const usable = listUsableSkills(state, actor);
  if (usable.length === 0) return noAction;

  const forcedId = getForcedTargetId(state, actor);
  if (forcedId) return { command: useSkill(actor, usable[0], forcedId), kind: "provoked" };

  const healThreshold = Number.isFinite(options?.healThreshold) ? Number(options?.healThreshold) : 0.5;
  const prioritized = sortByPriority(actor, usable);
  const allies = listUnitsBySide(state, actor.sideId);

  if (allies.some((unit) => unit.currentHp <= 0 && !buildStatusSummary(unit).unrevivable)) {
    for (const skill of prioritized) {
      if (!skillCanTargetDeadAllies(skill)) continue;
      const dead = listValidTargetIds(state, actor, skill).filter((id) => {
        const unit = getBattleUnit(state, id);
        return !!unit && unit.currentHp <= 0 && !buildStatusSummary(unit).unrevivable;
      });
      if (dead.length > 0) return { command: useSkill(actor, skill, dead[0]), kind: "revive" };
    }
  }

  if (allies.some((unit) => unit.currentHp > 0 && hpRatio(unit) < healThreshold)) {
    for (const skill of prioritized) {
      if (!hasHealEffect(skill) || resolveSkillTargetSide(skill) === "Enemy") continue;
      const ids = listValidTargetIds(state, actor, skill).filter((id) => (getBattleUnit(state, id)?.currentHp ?? 0) > 0);
      const target = pickUnit(state, ids, (a, b) => hpRatio(a) < hpRatio(b) || (hpRatio(a) === hpRatio(b) && a.currentHp < b.currentHp));
      if (target) return { command: useSkill(actor, skill, target), kind: "heal" };
    }
  }

  for (const skill of prioritized) {
    if (!hasCleanseEffect(skill) || resolveSkillTargetSide(skill) === "Enemy") continue;
    const ids = listValidTargetIds(state, actor, skill).filter((id) => {
      const unit = getBattleUnit(state, id);
      return !!unit && unit.currentHp > 0;
    });
    const needy = isAreaSkill(skill)
      ? (allies.some((unit) => unit.currentHp > 0 && countDispellableDebuffs(unit) > 0) ? ids : [])
      : ids.filter((id) => countDispellableDebuffs(getBattleUnit(state, id) as BattleUnitState) > 0);
    const target = pickUnit(state, needy, (a, b) => countDispellableDebuffs(a) > countDispellableDebuffs(b));
    if (target) return { command: useSkill(actor, skill, target), kind: "cleanse" };
  }

  for (const skill of prioritized) {
    if (resolveSkillTargetSide(skill) === "Enemy") continue;
    const buffs = listBuffStatuses(skill);
    if (buffs.length === 0) continue;
    const ids = listValidTargetIds(state, actor, skill).filter((id) => (getBattleUnit(state, id)?.currentHp ?? 0) > 0);
    const candidates = isAreaSkill(skill) || resolveSkillTargetSide(skill) === "Self"
      ? (allies.some((unit) => unit.currentHp > 0 && lacksAnyStatus(unit, buffs)) ? ids : [])
      : ids.filter((id) => lacksAnyStatus(getBattleUnit(state, id) as BattleUnitState, buffs));
    if (candidates.length > 0) return { command: useSkill(actor, skill, candidates[0]), kind: "buff" };
  }

  for (const skill of prioritized) {
    if (resolveSkillTargetSide(skill) !== "Enemy") continue;
    const ids = listValidTargetIds(state, actor, skill);
    const preference = targetPreference(skill);
    const target = pickUnit(state, ids, (a, b) => {
      if (preference) {
        const preferenceA = preference(a);
        const preferenceB = preference(b);
        if (preferenceA !== preferenceB) return preferenceA > preferenceB;
      }
      const relationA = compareElements(formulas, actor.elementId, a.elementId);
      const relationB = compareElements(formulas, actor.elementId, b.elementId);
      if (relationA !== relationB) return relationA > relationB;
      if (hpRatio(a) !== hpRatio(b)) return hpRatio(a) < hpRatio(b);
      return a.currentHp < b.currentHp;
    });
    if (target) return { command: useSkill(actor, skill, target), kind: "attack" };
  }

  for (const skill of usable) {
    const ids = listValidTargetIds(state, actor, skill);
    if (ids.length > 0) return { command: useSkill(actor, skill, ids[0]), kind: "fallback" };
  }

  return noAction;
}

/** Convenience wrapper returning only the command. */
export function chooseAiCommand(
  state: BattleState,
  actorId: string,
  formulas: Pick<CombatFormulaSnapshot | ResolvedCombatFormula, "elements">,
  options?: BattleAiOptions
): BattleCommand {
  return decideAiCommand(state, actorId, formulas, options).command;
}
