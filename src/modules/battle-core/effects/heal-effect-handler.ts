import type { BattleEvent } from "../domain/battle-event";
import { resolveCombatFormula } from "../domain/combat-formula";
import type { CombatFormulaProvider } from "../application/combat-formula-provider";
import type { BattleEffectExecutionContext, BattleEffectHandler } from "../application/effect-handler-registry";
import { applyDirectHeal } from "../statuses/status-engine";
import { computeHealAmount } from "./combat-effect-math";

export class HealEffectHandler implements BattleEffectHandler {
  readonly id = "heal-effect-handler";

  constructor(private readonly formulaProvider: CombatFormulaProvider) {}

  supports(effect: BattleEffectExecutionContext["effect"]): boolean {
    return effect.type === "Heal";
  }

  execute(context: BattleEffectExecutionContext): BattleEvent[] {
    const formulas = context.formulas ?? resolveCombatFormula(this.formulaProvider.getSnapshot());
    const events: BattleEvent[] = [];

    for (const target of context.targets) {
      const repeat = context.repeat?.[target.unitId] ?? 1;
      for (let i = 0; i < repeat; i++) {
        const amount = computeHealAmount(
          formulas,
          context.actor,
          target,
          context.effect.healFromSource !== false,
          context.effect.healStat,
          context.effect.healScale,
          context.effect.flatHealBonus
        );

        events.push(...applyDirectHeal({
          target,
          amount,
          sourceId: context.actor.unitId,
          skillId: context.skill.id,
        }).events);
      }
    }

    return events;
  }
}
