import type { BattleEvent } from "../domain/battle-event";
import { resolveCombatFormula } from "../domain/combat-formula";
import type { CombatFormulaProvider } from "../application/combat-formula-provider";
import type { BattleEffectExecutionContext, BattleEffectHandler } from "../application/effect-handler-registry";
import { applyRevive } from "../statuses/status-engine";
import { getMaxTurnBar, getTurnOrderSystem } from "../application/turn-order-system";

export class ReviveEffectHandler implements BattleEffectHandler {
  readonly id = "revive-effect-handler";

  constructor(private readonly formulaProvider: CombatFormulaProvider) {}

  supports(effect: BattleEffectExecutionContext["effect"]): boolean {
    return effect.type === "Revive";
  }

  execute(context: BattleEffectExecutionContext): BattleEvent[] {
    const formulas = context.formulas ?? resolveCombatFormula(this.formulaProvider.getSnapshot());
    const events: BattleEvent[] = [];

    for (const target of context.targets) {
      const hpPercent = Number.isFinite(context.effect.reviveHpPercent) ? context.effect.reviveHpPercent : 0.3;
      const result = applyRevive({
        target,
        hpPercent,
        sourceId: context.actor.unitId,
        skillId: context.skill.id,
        cleanseDebuffs: formulas.revive.cleanseDebuffsOnRevive,
        shieldAmount: target.maxHp * formulas.revive.shieldPercentOnRevive,
        turnBarAmount: target.turnThreshold * formulas.revive.turnBarPercentOnRevive,
        maxTurnBar: getMaxTurnBar(target, formulas),
      });

      events.push(...result.events);
      if (result.ok) events.push(...getTurnOrderSystem(formulas).onUnitRevived(context.state, target, formulas));
    }

    return events;
  }
}
