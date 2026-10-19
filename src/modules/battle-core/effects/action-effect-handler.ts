import type { BattleEvent } from "../domain/battle-event";
import type { BattleUnitState } from "../domain/battle-state";
import { listUnitsBySide } from "../domain/battle-state-utils";
import type { BattleEffectExecutionContext, BattleEffectHandler } from "../application/effect-handler-registry";
import { pickRandomUnits } from "../application/targeting-resolver";
import { buildStatusSummary } from "../statuses/status-rules";
import { resolveSkillTargetSide } from "../skills/skill-rules";
import { rollChance } from "./combat-effect-math";

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** Living allies of the caster (not the caster) that can join an AllyAttack: able to act, skill 1 aimed at enemies. */
function listAllyAttackCandidates(context: BattleEffectExecutionContext): BattleUnitState[] {
  return listUnitsBySide(context.state, context.actor.sideId).filter((unit) => {
    if (unit.unitId === context.actor.unitId || unit.currentHp <= 0) return false;
    if (buildStatusSummary(unit).cannotAct) return false;
    const first = unit.skills[0];
    return !!first && resolveSkillTargetSide(first) === "Enemy";
  });
}

/**
 * Caster effects that change the action rather than a unit: ExtraTurn, AdditionalAttack and AllyAttack. Each rolls
 * `baseChance` (no RNG at 100%) and records its outcome in `context.signals`; the engine grants the extra turn at the
 * end of the turn and runs the follow-up attacks after the skill resolved. Without signals (or when the action does not
 * allow them: follow-up attacks, ExtraTurn outside the caster's own turn) the effect does nothing and rolls nothing.
 */
export class ActionEffectHandler implements BattleEffectHandler {
  readonly id = "action-effect-handler";

  supports(effect: BattleEffectExecutionContext["effect"]): boolean {
    return effect.type === "ExtraTurn" || effect.type === "AdditionalAttack" || effect.type === "AllyAttack";
  }

  execute(context: BattleEffectExecutionContext): BattleEvent[] {
    const signals = context.signals;
    if (!signals) return [];
    const rng = () => context.rng.next();
    const chance = finiteOr(context.effect.baseChance, 1);

    switch (context.effect.type) {
      case "ExtraTurn":
        if (!signals.allowExtraTurn) return [];
        if (rollChance(chance, rng)) signals.extraTurn = true;
        return [];

      case "AdditionalAttack":
        if (!signals.allowFollowUps) return [];
        if (rollChance(chance, rng)) signals.additionalAttack = true;
        return [];

      case "AllyAttack": {
        if (!signals.allowFollowUps || !rollChance(chance, rng)) return [];
        const candidates = listAllyAttackCandidates(context).filter((unit) => !signals.allyAttackerIds.includes(unit.unitId));
        const count = Math.floor(finiteOr(context.effect.buffCount, 1));
        const picked = count <= 0 ? candidates : pickRandomUnits(candidates, count, context.rng);
        for (const unit of picked) signals.allyAttackerIds.push(unit.unitId);
        return [];
      }

      default:
        return [];
    }
  }
}
