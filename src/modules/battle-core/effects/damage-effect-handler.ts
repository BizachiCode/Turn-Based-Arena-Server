import type { BattleEvent } from "../domain/battle-event";
import { compareElements, resolveCombatFormula } from "../domain/combat-formula";
import type { CombatFormulaProvider } from "../application/combat-formula-provider";
import type { BattleEffectExecutionContext, BattleEffectHandler } from "../application/effect-handler-registry";
import { createSkillHitLedger, ensureHitRecord } from "../application/skill-hit-ledger";
import { applyDirectDamage, applyDirectHeal, destroyMaxHp } from "../statuses/status-engine";
import { buildStatusSummary } from "../statuses/status-rules";
import { getEffectHits } from "../skills/skill-rules";
import {
  computeDamageFromTerms,
  computeDamageScalingMultiplier,
  rollCritical,
  rollCrushing,
  rollGlancing,
  rollHit,
} from "./combat-effect-math";

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/**
 * Damage effect. Hits are resolved hit-major (hit 1 on every target, then hit 2, ...). Every hit rolls
 * Invincibility, hit (evasion), glancing (skipped with `noGlancing`), critical (skipped with `guaranteedCrit`) and
 * crushing separately and emits its own `damage_applied` / `attack_missed` with `hitIndex` / `hitCount`; Destroy
 * (`destroyMaxHp`) follows each hit, then ReflectDamage. Hits on dead targets are lost and the effect stops when the
 * attacker dies (e.g. from reflected damage). After the hits the caster heals `lifeSteal` x the HP damage dealt.
 */
export class DamageEffectHandler implements BattleEffectHandler {
  readonly id = "damage-effect-handler";

  constructor(private readonly formulaProvider: CombatFormulaProvider) {}

  supports(effect: BattleEffectExecutionContext["effect"]): boolean {
    return effect.type === "Damage";
  }

  execute(context: BattleEffectExecutionContext): BattleEvent[] {
    const formulas = context.formulas ?? resolveCombatFormula(this.formulaProvider.getSnapshot());
    const ledger = context.ledger ?? createSkillHitLedger();
    const events: BattleEvent[] = [];
    const rng = () => context.rng.next();
    const hitCount = getEffectHits(context.effect);
    const actor = context.actor;
    const effect = context.effect;
    const destroyFraction = Math.max(0, finiteOr(effect.destroyMaxHp, 0));
    let dealt = 0;
    ledger.hasDamage = true;

    for (let hitIndex = 0; hitIndex < hitCount; hitIndex++) {
      for (const target of context.targets) {
        if (actor.currentHp <= 0) return events;
        if (target.currentHp <= 0) continue;

        const record = ensureHitRecord(ledger, target.unitId);
        record.attempted += 1;

        if (buildStatusSummary(target).invulnerable) {
          events.push({
            type: "attack_missed",
            sourceId: actor.unitId,
            targetId: target.unitId,
            reason: "invulnerable",
            skillId: context.skill.id,
            hitIndex,
            hitCount,
          });
          continue;
        }

        if (!rollHit(formulas, actor, target, rng)) {
          events.push({
            type: "attack_missed",
            sourceId: actor.unitId,
            targetId: target.unitId,
            reason: "evasion",
            skillId: context.skill.id,
            hitIndex,
            hitCount,
          });
          continue;
        }

        const relation = compareElements(formulas, actor.elementId, target.elementId);
        const isGlancing = effect.noGlancing ? false : rollGlancing(formulas, actor, target, rng, relation);
        const isCritical = rollCritical(actor, isGlancing, formulas, rng, relation, target, !!effect.guaranteedCrit);
        const isCrushing = rollCrushing(formulas, relation, isCritical, isGlancing, rng);
        const amount = computeDamageFromTerms(
          formulas,
          actor,
          target,
          effect.damageTerms,
          effect.flatDamageBonus,
          effect.defenseConstant,
          effect.critMultiplier,
          isCritical,
          isGlancing,
          isCrushing,
          relation,
          {
            ignoreDefense: effect.ignoreDefense,
            critDamageBonus: effect.critDamageBonus,
            scalingMultiplier: computeDamageScalingMultiplier(effect, actor, target),
          }
        );

        const result = applyDirectDamage({
          target,
          amount,
          sourceId: actor.unitId,
          skillId: context.skill.id,
          canBreakSleep: true,
          isCritical,
          isGlancing,
          isCrushing,
          elementRelation: relation,
          hitIndex,
          hitCount,
          kind: "attack",
        });
        events.push(...result.events);

        record.landed += 1;
        ledger.totalLanded += 1;
        if (!isGlancing) record.harmfulLanded += 1;
        if (isCritical) {
          record.crits += 1;
          ledger.totalCrits += 1;
        }
        if (target.currentHp <= 0) {
          record.kills += 1;
          ledger.totalKills += 1;
        }

        const hpDamage = this.hpDamageOf(target, result.events);
        if (target.sideId !== actor.sideId) dealt += hpDamage;
        if (destroyFraction > 0 && hpDamage > 0) {
          events.push(...destroyMaxHp(target, hpDamage * destroyFraction, actor.unitId, formulas.damage.destroyMaxHpCap).events);
        }

        events.push(...this.reflect(context, target, result.events));
      }
    }

    events.push(...this.lifeSteal(context, dealt));
    return events;
  }

  private hpDamageOf(target: BattleEffectExecutionContext["actor"], hitEvents: BattleEvent[]): number {
    let hpDamage = 0;
    for (const event of hitEvents) {
      if (event.type === "damage_applied" && event.targetId === target.unitId) hpDamage += event.amount;
    }
    return hpDamage;
  }

  /** Life steal: the living caster heals `lifeSteal` x the HP damage the effect dealt to enemies. */
  private lifeSteal(context: BattleEffectExecutionContext, dealt: number): BattleEvent[] {
    const fraction = Math.max(0, finiteOr(context.effect.lifeSteal, 0));
    if (!(fraction > 0) || dealt <= 0 || context.actor.currentHp <= 0) return [];
    const amount = Math.round(dealt * fraction);
    if (amount <= 0) return [];
    return applyDirectHeal({
      target: context.actor,
      amount,
      sourceId: context.actor.unitId,
      skillId: context.skill.id,
      kind: "lifesteal",
    }).events;
  }

  /** ReflectDamage: the defender returns a fraction of the HP damage of the hit to the attacker. */
  private reflect(context: BattleEffectExecutionContext, target: BattleEffectExecutionContext["actor"], hitEvents: BattleEvent[]): BattleEvent[] {
    if (target.currentHp <= 0 || context.actor.currentHp <= 0 || target.unitId === context.actor.unitId) return [];

    const percent = buildStatusSummary(target).reflectDamagePercent;
    if (!(percent > 0)) return [];

    const reflected = Math.round(this.hpDamageOf(target, hitEvents) * percent);
    if (reflected <= 0) return [];

    return applyDirectDamage({
      target: context.actor,
      amount: reflected,
      sourceId: target.unitId,
      skillId: null,
      canBreakSleep: false,
      kind: "reflect",
    }).events;
  }
}
