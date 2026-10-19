import type {
  BattleRuntimeBattleStartedContext,
  BattleRuntimeSkillResolvedContext,
  BattleRuntimeSystem,
  BattleRuntimeTurnCompletedContext,
} from "../application/battle-runtime-system";
import { EXTRA_TURN_METADATA_KEY, getTurnOrderSystem } from "../application/turn-order-system";
import type { BattleUnitState } from "../domain/battle-state";
import type { BattleEvent } from "../domain/battle-event";
import { getBattleUnit, listBattleUnits } from "../domain/battle-state-utils";
import { readBattleRuneSetEffects } from "../domain/rune-set-effects";
import { rollChance } from "../effects/combat-effect-math";
import { resolveCombatFormula } from "../domain/combat-formula";
import { applyDirectHeal, applyStatus, destroyMaxHp } from "../statuses/status-engine";

type DamageAppliedEvent = Extract<BattleEvent, { type: "damage_applied" }>;

function readUnitRuneSetEffects(unit: BattleUnitState) {
  return readBattleRuneSetEffects(unit.metadata?.runeSetEffects);
}

/** Attack hits of the acting unit on enemies (reflect / bomb damage excluded). */
function listActorHits(context: BattleRuntimeSkillResolvedContext): DamageAppliedEvent[] {
  return context.effectEvents.filter((event): event is DamageAppliedEvent => {
    if (event.type !== "damage_applied" || event.kind !== "attack" || event.sourceId !== context.actor.unitId) return false;
    const target = getBattleUnit(context.state, event.targetId);
    return !!target && target.sideId !== context.actor.sideId;
  });
}

/**
 * Rune set specials (data in `unit.metadata.runeSetEffects`): start-of-battle Immunity (Will), Nemesis ATB on HP
 * lost (blocked by Freeze), Destroy max HP (shared 60% battle cap), Vampire lifesteal, Despair stun on non-glancing
 * hits, Violent extra turn (not rolled when the turn already earned an extra turn). Rune counterattack (Revenge) is
 * resolved by the engine together with the Counterattack buff.
 */
export class RuneSetRuntimeSystem implements BattleRuntimeSystem {
  readonly id = "rune-set-runtime-system";

  onBattleStarted(context: BattleRuntimeBattleStartedContext): BattleEvent[] {
    const events: BattleEvent[] = [];

    for (const unit of listBattleUnits(context.state)) {
      if (unit.currentHp <= 0) continue;

      const effects = readUnitRuneSetEffects(unit);
      if (effects.startOfBattleImmunityTurns <= 0) continue;

      const applied = applyStatus({
        source: unit,
        target: unit,
        status: "Immunity",
        duration: effects.startOfBattleImmunityTurns,
        isBuff: true,
        skipResistance: true,
        formulas: context.formulas ?? null,
      }, () => context.rng.next());

      events.push(...applied.events);
    }

    return events;
  }

  onSkillResolved(context: BattleRuntimeSkillResolvedContext): BattleEvent[] {
    const actorEffects = readUnitRuneSetEffects(context.actor);
    const events: BattleEvent[] = [];
    const hits = listActorHits(context);
    const formulas = resolveCombatFormula(context.formulas);
    const turnOrder = getTurnOrderSystem(formulas);

    for (const hit of hits) {
      if (hit.amount <= 0) continue;
      const target = getBattleUnit(context.state, hit.targetId);
      if (!target || target.currentHp <= 0) continue;

      const targetEffects = readUnitRuneSetEffects(target);
      if (targetEffects.atbGainPerHpLostPercent > 0 && target.maxHp > 0) {
        const hpLostRatio = hit.amount / Math.max(1, target.maxHp);
        const turnBarGain = target.turnThreshold * hpLostRatio * targetEffects.atbGainPerHpLostPercent;
        events.push(...turnOrder.applyTurnBarChange(target, turnBarGain, formulas, true));
      }
    }

    if (actorEffects.destroyMaxHpPercentPerHit > 0) {
      for (const hit of hits) {
        if (hit.amount <= 0) continue;
        const target = getBattleUnit(context.state, hit.targetId);
        if (!target) continue;
        events.push(...destroyMaxHp(target, hit.amount * actorEffects.destroyMaxHpPercentPerHit, context.actor.unitId,
          resolveCombatFormula(context.formulas).damage.destroyMaxHpCap).events);
      }
    }

    if (actorEffects.lifestealPercent > 0 && context.actor.currentHp > 0) {
      let totalDamage = 0;
      for (const hit of hits) totalDamage += hit.amount;

      events.push(...applyDirectHeal({
        target: context.actor,
        amount: Math.round(totalDamage * actorEffects.lifestealPercent),
        sourceId: context.actor.unitId,
        skillId: context.skill.id,
        kind: "lifesteal",
      }).events);
    }

    if (actorEffects.stunOnHitChance > 0) {
      for (const hit of hits) {
        if (hit.isGlancing || (hit.amount + (hit.absorbed ?? 0)) <= 0) continue;
        const target = getBattleUnit(context.state, hit.targetId);
        if (!target || target.currentHp <= 0) continue;

        events.push(...applyStatus({
          source: context.actor,
          target,
          status: "Stun",
          duration: 1,
          applyChance: actorEffects.stunOnHitChance,
          isBuff: false,
          formulas: context.formulas ?? null,
        }, () => context.rng.next()).events);
      }
    }

    return events;
  }

  onTurnCompleted(context: BattleRuntimeTurnCompletedContext): BattleEvent[] {
    if (context.reason !== "skill_resolved" || context.actor.currentHp <= 0) return [];
    if (context.state.metadata[EXTRA_TURN_METADATA_KEY] === context.actor.unitId) return [];

    const effects = readUnitRuneSetEffects(context.actor);
    if (!rollChance(effects.extraTurnChance, () => context.rng.next())) return [];

    const formulas = resolveCombatFormula(context.formulas);
    return [
      {
        type: "extra_turn_granted",
        battleId: context.state.battleId,
        actorId: context.actor.unitId,
        source: "rune_set",
      },
      ...getTurnOrderSystem(formulas).grantExtraTurn(context.state, context.actor, formulas),
    ];
  }
}
