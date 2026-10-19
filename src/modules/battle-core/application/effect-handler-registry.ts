import type { BattleRandom } from "../domain/battle-random";
import type { BattleEvent } from "../domain/battle-event";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import type { ResolvedCombatFormula } from "../domain/combat-formula";
import type { CharacterSkillDTO, SkillEffectDTO } from "../types/battle-data";
import type { SkillHitLedger } from "./skill-hit-ledger";

/**
 * Action-level outcomes of one skill (or passive bundle) resolution, written by caster effects (ExtraTurn,
 * AdditionalAttack, AllyAttack) and read by the engine once the effects resolved.
 */
export type SkillSignals = {
  /** ExtraTurn may apply (the caster is the acting unit). */
  allowExtraTurn: boolean;
  /** AdditionalAttack / AllyAttack may apply (turn actions only: follow-ups never chain). */
  allowFollowUps: boolean;
  extraTurn: boolean;
  additionalAttack: boolean;
  /** Allies picked by AllyAttack, in pick order. */
  allyAttackerIds: string[];
};

export function createSkillSignals(allowExtraTurn: boolean, allowFollowUps: boolean): SkillSignals {
  return { allowExtraTurn, allowFollowUps, extraTurn: false, additionalAttack: false, allyAttackerIds: [] };
}

export type BattleEffectExecutionContext = {
  state: BattleState;
  actor: BattleUnitState;
  primaryTarget: BattleUnitState;
  /** Targets after scope, alive/dead filtering, condition and hit gating. */
  targets: BattleUnitState[];
  skill: CharacterSkillDTO;
  effect: SkillEffectDTO;
  skillLevel: number;
  rng: BattleRandom;
  /** Resolved formula snapshot of the battle (handlers fall back to their own provider when missing). */
  formulas?: ResolvedCombatFormula;
  /** Hit bookkeeping of the current skill (Damage effects write it). */
  ledger?: SkillHitLedger;
  /** Repetitions per target id (applyEverySplit); missing = 1. */
  repeat?: Record<string, number>;
  /** Passive that is resolving this effect (null for skills). */
  passiveId?: string | null;
  /** Action outcomes of the current resolution (caster effects write them). */
  signals?: SkillSignals;
};

export interface BattleEffectHandler {
  readonly id: string;
  supports(effect: SkillEffectDTO): boolean;
  execute(context: BattleEffectExecutionContext): BattleEvent[];
}

export class BattleEffectHandlerRegistry {
  private readonly handlers: BattleEffectHandler[] = [];

  register(handler: BattleEffectHandler): this {
    this.handlers.push(handler);
    return this;
  }

  execute(context: BattleEffectExecutionContext): BattleEvent[] {
    const events: BattleEvent[] = [];

    for (const handler of this.handlers) {
      if (!handler.supports(context.effect)) continue;
      events.push(...handler.execute(context));
    }

    return events;
  }
}
