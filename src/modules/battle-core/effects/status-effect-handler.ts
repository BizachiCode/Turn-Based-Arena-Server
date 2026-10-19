import type { BattleEvent } from "../domain/battle-event";
import type { BattleUnitState } from "../domain/battle-state";
import { resolveCombatFormula, type ResolvedCombatFormula } from "../domain/combat-formula";
import type { CombatFormulaProvider } from "../application/combat-formula-provider";
import type { BattleEffectExecutionContext, BattleEffectHandler } from "../application/effect-handler-registry";
import { getUnitSkillCooldown } from "../skills/skill-rules";
import type { SkillEffectDTO } from "../types/battle-data";
import { computeBombValue, computeShieldValue } from "./combat-effect-math";
import { applyStatusSubsystemEffect, type StatusSubsystemOptions } from "./status-effect-executor";
import { getStatusDefault } from "../domain/combat-formula";
import { getMaxTurnBar } from "../application/turn-order-system";

const SUPPORTED_TYPES = new Set([
  "ApplyStatus",
  "Strip",
  "StealBuffs",
  "TurnBar",
  "CooldownChange",
  "Cleanse",
  "AbsorbTurnBar",
  "TransferDebuffs",
  "ChangeStatusDuration",
]);

function computeValue(
  formulas: ResolvedCombatFormula,
  effect: SkillEffectDTO,
  actor: BattleUnitState,
  target: BattleUnitState
): number | null {
  if (effect.type !== "ApplyStatus") return null;
  if (effect.status !== "Shield" && effect.status !== "Bomb") return null;
  const authored = Number.isFinite(effect.statusMagnitude) ? effect.statusMagnitude : 0;
  const magnitude = authored !== 0 ? authored : getStatusDefault(formulas, effect.status).magnitude;
  return effect.status === "Shield"
    ? computeShieldValue(actor, magnitude)
    : computeBombValue(formulas, actor, target, magnitude);
}

/**
 * Skills a CooldownChange may touch on `target`. A decrease applied by a skill to its own caster never shortens that
 * skill (the skill's cooldown starts after it is used; "resets the cooldown of the other skills").
 */
function buildCooldownOptions(
  effect: SkillEffectDTO,
  target: BattleUnitState,
  casterSkillId: string | null
): Pick<StatusSubsystemOptions, "eligibleCooldownSkillIds" | "maxCooldowns"> {
  if (effect.type !== "CooldownChange") return {};
  const increase = effect.cooldownIncrease !== false;
  const eligible: string[] = [];
  const maxCooldowns: Record<string, number> = {};

  for (const skill of target.skills) {
    const max = getUnitSkillCooldown(target, skill);
    maxCooldowns[skill.id] = max;
    const current = target.cooldowns[skill.id] ?? 0;
    if (!increase && skill.id === casterSkillId) continue;
    if (increase ? max > 0 : current > 0) eligible.push(skill.id);
  }

  return { eligibleCooldownSkillIds: eligible, maxCooldowns };
}

export class StatusEffectHandler implements BattleEffectHandler {
  readonly id = "status-effect-handler";

  constructor(private readonly formulaProvider: CombatFormulaProvider) {}

  supports(effect: BattleEffectExecutionContext["effect"]): boolean {
    return SUPPORTED_TYPES.has(effect.type);
  }

  execute(context: BattleEffectExecutionContext): BattleEvent[] {
    const formulas = context.formulas ?? resolveCombatFormula(this.formulaProvider.getSnapshot());
    const events: BattleEvent[] = [];
    const actingSelf = context.state.actingUnitId === context.actor.unitId;

    for (const target of context.targets) {
      const repeat = context.repeat?.[target.unitId] ?? 1;
      for (let i = 0; i < repeat; i++) {
        if (target.currentHp <= 0) break;
        const result = applyStatusSubsystemEffect(
          context.effect,
          context.actor,
          target,
          formulas,
          () => context.rng.next(),
          {
            sameSide: target.sideId === context.actor.sideId,
            skipNextTick: actingSelf,
            passiveId: context.passiveId ?? null,
            skillId: context.skill.id,
            value: computeValue(formulas, context.effect, context.actor, target),
            maxTurnBar: getMaxTurnBar(target, formulas),
            sourceMaxTurnBar: getMaxTurnBar(context.actor, formulas),
            ...buildCooldownOptions(context.effect, target, target.unitId === context.actor.unitId ? context.skill.id : null),
          }
        );

        events.push(...result.events);
      }
    }

    return events;
  }
}
