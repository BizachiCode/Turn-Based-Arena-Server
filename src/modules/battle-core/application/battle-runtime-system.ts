import type { BattleEvent, BattleTurnEndReason } from "../domain/battle-event";
import type { BattleRandom } from "../domain/battle-random";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import type { ResolvedCombatFormula } from "../domain/combat-formula";
import type { UnitDeathCause } from "../statuses/status-models";
import type { CharacterSkillDTO, SkillEffectDTO } from "../types/battle-data";

/** Why a skill was used: the turn action or a follow-up (counterattack, additional attack, ally attack). */
export type BattleRuntimeTriggerSource = "turn_action" | "counterattack" | "additional_attack" | "ally_attack";

export type BattleRuntimeBattleStartedContext = {
  state: BattleState;
  rng: BattleRandom;
  formulas?: ResolvedCombatFormula;
  resolveEffectBundle(request: BattleRuntimeEffectBundleRequest): BattleEvent[];
};

export type BattleRuntimeFollowUpSkillRequest = {
  actor: BattleUnitState;
  primaryTarget: BattleUnitState;
  skill?: CharacterSkillDTO | null;
  skillLevel?: number;
  triggerSource: BattleRuntimeTriggerSource;
  /** AllyAttack: the unit whose skill called the ally. */
  requesterId?: string | null;
};

export type BattleRuntimeEffectBundleRequest = {
  actor: BattleUnitState;
  primaryTarget: BattleUnitState;
  targets?: BattleUnitState[];
  sourceId: string;
  sourceName?: string | null;
  effects: SkillEffectDTO[];
  skillLevel?: number;
  /** Passive resolving the bundle (statuses it grants its owner are suppressed by Oblivion). */
  passiveId?: string | null;
  /**
   * Unit that "target" conditions read when an effect lands on the actor's own side (passives: the trigger's primary
   * target / attacker). Defaults to `primaryTarget`.
   */
  conditionTarget?: BattleUnitState | null;
};

export type BattleRuntimeTurnStartedContext = {
  state: BattleState;
  actor: BattleUnitState;
  rng: BattleRandom;
  formulas?: ResolvedCombatFormula;
  resolveEffectBundle(request: BattleRuntimeEffectBundleRequest): BattleEvent[];
};

export type BattleRuntimeSkillResolvedContext = {
  state: BattleState;
  actor: BattleUnitState;
  primaryTarget: BattleUnitState;
  targets: BattleUnitState[];
  skill: CharacterSkillDTO;
  skillLevel: number;
  rng: BattleRandom;
  formulas?: ResolvedCombatFormula;
  effectEvents: BattleEvent[];
  triggerSource: BattleRuntimeTriggerSource;
  resolveFollowUpSkill(request: BattleRuntimeFollowUpSkillRequest): BattleEvent[];
  resolveEffectBundle(request: BattleRuntimeEffectBundleRequest): BattleEvent[];
};

/** A skill is about to resolve (after `skill_used`, before its effects): BeforeAttack passives. */
export type BattleRuntimeSkillStartingContext = {
  state: BattleState;
  actor: BattleUnitState;
  primaryTarget: BattleUnitState;
  targets: BattleUnitState[];
  skill: CharacterSkillDTO;
  skillLevel: number;
  rng: BattleRandom;
  formulas?: ResolvedCombatFormula;
  triggerSource: BattleRuntimeTriggerSource;
  resolveEffectBundle(request: BattleRuntimeEffectBundleRequest): BattleEvent[];
};

/** The acting unit's turn is ending (before the end-of-turn status tick): OnTurnEnd passives. */
export type BattleRuntimeTurnEndingContext = {
  state: BattleState;
  actor: BattleUnitState;
  reason: BattleTurnEndReason;
  rng: BattleRandom;
  formulas?: ResolvedCombatFormula;
  resolveEffectBundle(request: BattleRuntimeEffectBundleRequest): BattleEvent[];
};

export type BattleRuntimeTurnCompletedContext = {
  state: BattleState;
  actor: BattleUnitState;
  reason: BattleTurnEndReason;
  rng: BattleRandom;
  formulas?: ResolvedCombatFormula;
};

/** Raised for deaths outside skill resolution (continuous damage at turn start, bomb at turn end). */
export type BattleRuntimeUnitDiedContext = {
  state: BattleState;
  unit: BattleUnitState;
  killer: BattleUnitState | null;
  cause: UnitDeathCause;
  rng: BattleRandom;
  formulas?: ResolvedCombatFormula;
  resolveEffectBundle(request: BattleRuntimeEffectBundleRequest): BattleEvent[];
};

export interface BattleRuntimeSystem {
  readonly id: string;
  onBattleStarted?(context: BattleRuntimeBattleStartedContext): BattleEvent[];
  onTurnStarted?(context: BattleRuntimeTurnStartedContext): BattleEvent[];
  onSkillStarting?(context: BattleRuntimeSkillStartingContext): BattleEvent[];
  onSkillResolved?(context: BattleRuntimeSkillResolvedContext): BattleEvent[];
  onTurnEnding?(context: BattleRuntimeTurnEndingContext): BattleEvent[];
  onTurnCompleted?(context: BattleRuntimeTurnCompletedContext): BattleEvent[];
  onUnitDied?(context: BattleRuntimeUnitDiedContext): BattleEvent[];
}
