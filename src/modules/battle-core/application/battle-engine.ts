import { StaticCombatFormulaProvider, type CombatFormulaProvider } from "./combat-formula-provider";
import type {
  BattleRuntimeEffectBundleRequest,
  BattleRuntimeFollowUpSkillRequest,
  BattleRuntimeSystem,
  BattleRuntimeTriggerSource,
} from "./battle-runtime-system";
import { BattleEffectHandlerRegistry, createSkillSignals, type SkillSignals } from "./effect-handler-registry";
import { refreshPassiveAuras } from "./passive-auras";
import {
  filterTargetsForEffect,
  pickRandomUnits,
  resolveEffectScopeTargets,
  resolveSkillTargets,
} from "./targeting-resolver";
import { createSkillHitLedger, getEffectRepeatCount, isEffectConditionMet } from "./skill-hit-ledger";
import { EXTRA_TURN_METADATA_KEY, PENDING_EXTRA_TURN_METADATA_KEY, getTurnOrderSystem } from "./turn-order-system";
import { ActionEffectHandler } from "../effects/action-effect-handler";
import { DamageEffectHandler } from "../effects/damage-effect-handler";
import { HealEffectHandler } from "../effects/heal-effect-handler";
import { ReviveEffectHandler } from "../effects/revive-effect-handler";
import { StatusEffectHandler } from "../effects/status-effect-handler";
import { rollChance } from "../effects/combat-effect-math";
import {
  BATTLE_RNG_STATE_METADATA_KEY,
  BATTLE_SEED_METADATA_KEY,
  createBattleRandomFromMetadata,
  type BattleRandom,
} from "../domain/battle-random";
import type { BattleCommand, UseSkillCommand } from "../domain/battle-command";
import type { BattleEvent, BattleTurnEndReason } from "../domain/battle-event";
import { resolveCombatFormula, type ResolvedCombatFormula } from "../domain/combat-formula";
import { readBattleRuneSetEffects } from "../domain/rune-set-effects";
import {
  cloneBattleState,
  finishBattle,
  getBattleUnit,
  getEnemySideIds,
  listAliveEnemyUnits,
  listAliveUnitsBySide,
  readMetadataString,
  setBattlePhase,
} from "../domain/battle-state-utils";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import type { BattleRuleset } from "../rulesets/battle-ruleset";
import { buildStatusSummary } from "../statuses/status-rules";
import type { UnitDeathCause } from "../statuses/status-models";
import { tickStatusesEndOfTurn, tickStatusesStartOfTurn } from "../statuses/status-engine";
import type { CharacterSkillDTO } from "../types/battle-data";
import {
  applySkillLevelToEffect,
  findUnitSkill,
  getSkillLevelBonus,
  getSkillUsabilityFailure,
  getUnitSkillCooldown,
  getUnitSkillLevel,
  listUsableSkills,
  resolveSkillTargetSide,
  validateSkillTarget,
} from "../skills/skill-rules";

export type BattleEngineResult = {
  accepted: boolean;
  state: BattleState;
  events: BattleEvent[];
  error?: string;
};

/** Per-dispatch working context: the cloned state, its RNG, the resolved formulas and the event sink. */
type DispatchContext = {
  state: BattleState;
  rng: BattleRandom;
  formulas: ResolvedCombatFormula;
  events: BattleEvent[];
};

type SkillExecutionOptions = {
  passiveId?: string | null;
  allowDeadActor?: boolean;
  /** Action outcomes (ExtraTurn, AdditionalAttack, AllyAttack); missing = caster effects do nothing. */
  signals?: SkillSignals;
  /** Unit read by "target" conditions of effects landing on the actor's side (default: the primary target). */
  conditionTarget?: BattleUnitState | null;
};

/** Source of a pending extra turn (`metadata.pendingExtraTurn`). */
type PendingExtraTurn = {
  actorId: string;
  source: "skill" | "passive";
  skillId?: string;
  passiveId?: string;
};

function buildDefaultRegistry(formulaProvider: CombatFormulaProvider): BattleEffectHandlerRegistry {
  return new BattleEffectHandlerRegistry()
    .register(new DamageEffectHandler(formulaProvider))
    .register(new HealEffectHandler(formulaProvider))
    .register(new ReviveEffectHandler(formulaProvider))
    .register(new StatusEffectHandler(formulaProvider))
    .register(new ActionEffectHandler());
}

function readPendingExtraTurn(metadata: Record<string, unknown>): PendingExtraTurn | null {
  const raw = metadata[PENDING_EXTRA_TURN_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const pending = raw as Record<string, unknown>;
  if (typeof pending.actorId !== "string") return null;
  return {
    actorId: pending.actorId,
    source: pending.source === "passive" ? "passive" : "skill",
    skillId: typeof pending.skillId === "string" ? pending.skillId : undefined,
    passiveId: typeof pending.passiveId === "string" ? pending.passiveId : undefined,
  };
}

function reject(state: BattleState, command: BattleCommand, reason: string): BattleEngineResult {
  return {
    accepted: false,
    state,
    error: reason,
    events: [{
      type: "command_rejected",
      battleId: state.battleId,
      commandType: command.type,
      reason,
    }],
  };
}

/**
 * Pure, deterministic battle engine. Every call clones the input state, mutates the clone and returns it with
 * the produced events. Without an injected `rng`, the RNG state lives in `state.metadata` (`seed`, `rngState`)
 * so a battle can be replayed from its initial state and the list of commands.
 */
export class BattleEngine {
  private readonly effectRegistry: BattleEffectHandlerRegistry;
  private readonly formulaProvider: CombatFormulaProvider;
  private readonly fixedRng: BattleRandom | null;
  private readonly runtimeSystems: BattleRuntimeSystem[];

  constructor(
    private readonly ruleset: BattleRuleset,
    options?: {
      effectRegistry?: BattleEffectHandlerRegistry;
      combatFormulaProvider?: CombatFormulaProvider;
      /** Optional injected RNG (tests). When omitted the RNG is persisted in the battle state. */
      rng?: BattleRandom;
      runtimeSystems?: BattleRuntimeSystem[];
    }
  ) {
    this.formulaProvider = options?.combatFormulaProvider ?? new StaticCombatFormulaProvider();
    this.effectRegistry = options?.effectRegistry ?? buildDefaultRegistry(this.formulaProvider);
    this.fixedRng = options?.rng ?? null;
    this.runtimeSystems = Array.isArray(options?.runtimeSystems) ? options.runtimeSystems : [];
  }

  /** Resolved formula snapshot used by this engine. */
  getFormulas(): ResolvedCombatFormula {
    return resolveCombatFormula(this.formulaProvider.getSnapshot());
  }

  start(state: BattleState): BattleEngineResult {
    const next = cloneBattleState(state);
    if (next.phase !== "created") {
      return reject(next, { type: "start_turn", actorId: "" }, "BATTLE_ALREADY_STARTED");
    }

    if (!next.metadata) next.metadata = {};
    if (next.metadata[BATTLE_SEED_METADATA_KEY] === undefined || next.metadata[BATTLE_SEED_METADATA_KEY] === null) {
      next.metadata[BATTLE_SEED_METADATA_KEY] = next.battleId;
    }

    const ctx = this.createContext(next);
    ctx.events.push({
      type: "battle_started",
      battleId: next.battleId,
      mode: next.mode,
      rulesetId: next.rulesetId,
    });

    setBattlePhase(next, "waiting_for_turn", ctx.events);
    ctx.events.push(...refreshPassiveAuras(next));
    ctx.events.push(...(this.ruleset.onBattleStarted?.(next) ?? []));
    for (const system of this.runtimeSystems) {
      if (!system.onBattleStarted) continue;
      ctx.events.push(...system.onBattleStarted({
        state: next,
        rng: ctx.rng,
        formulas: ctx.formulas,
        resolveEffectBundle: (request) => this.resolveEffectBundle(ctx, request),
      }));
    }
    this.resolveBattleState(ctx);
    this.persistRng(ctx);

    return { accepted: true, state: next, events: ctx.events };
  }

  dispatch(state: BattleState, command: BattleCommand): BattleEngineResult {
    const next = cloneBattleState(state);
    if (!next.metadata) next.metadata = {};

    if (next.phase === "created") return reject(next, command, "BATTLE_NOT_STARTED");
    if (next.phase === "finished") return reject(next, command, "BATTLE_FINISHED");

    const baseValidation = this.validateCoreCommand(next, command);
    if (baseValidation) return reject(next, command, baseValidation);

    const rulesetValidation = this.ruleset.validateCommand(next, command);
    if (!rulesetValidation.ok) {
      return reject(next, command, "reason" in rulesetValidation ? rulesetValidation.reason : "INVALID_RULESET_COMMAND");
    }

    const ctx = this.createContext(next);

    switch (command.type) {
      case "start_turn":
        this.handleStartTurn(ctx, command.actorId);
        break;

      case "use_skill":
        this.handleUseSkill(ctx, command);
        break;

      case "end_turn": {
        const actor = getBattleUnit(next, command.actorId);
        if (actor) this.completeTurn(ctx, actor, command.reason ?? "manual");
        break;
      }

      case "surrender":
        this.handleSurrender(ctx, command.sideId);
        break;
    }

    this.resolveBattleState(ctx);
    this.persistRng(ctx);
    return { accepted: true, state: next, events: ctx.events };
  }

  private createContext(state: BattleState): DispatchContext {
    return {
      state,
      rng: this.fixedRng ?? createBattleRandomFromMetadata(state.metadata, state.battleId),
      formulas: this.getFormulas(),
      events: [],
    };
  }

  private persistRng(ctx: DispatchContext): void {
    if (this.fixedRng) return;
    ctx.state.metadata[BATTLE_RNG_STATE_METADATA_KEY] = ctx.rng.snapshot().state;
  }

  /** Returns a rejection reason, or null when the command is valid for the current state. */
  private validateCoreCommand(state: BattleState, command: BattleCommand): string | null {
    switch (command.type) {
      case "start_turn": {
        if (state.phase !== "waiting_for_turn") return "INVALID_PHASE";
        const actor = getBattleUnit(state, command.actorId);
        if (!actor) return "UNKNOWN_ACTOR";
        if (actor.currentHp <= 0) return "ACTOR_DEAD";
        if (!getTurnOrderSystem(this.getFormulas()).isReady(state, actor)) return "ACTOR_NOT_READY";
        return null;
      }

      case "use_skill": {
        if (state.phase !== "awaiting_action") return "INVALID_PHASE";
        if (state.actingUnitId !== command.actorId) return "NOT_ACTING_UNIT";

        const actor = getBattleUnit(state, command.actorId);
        if (!actor || actor.currentHp <= 0) return "ACTOR_DEAD";

        const skill = findUnitSkill(actor, command.skillId);
        if (!skill) return "UNKNOWN_SKILL";

        const usability = getSkillUsabilityFailure(state, actor, skill);
        if (usability) return usability;

        const target = validateSkillTarget(state, actor, skill, command.targetId);
        return "reason" in target ? target.reason : null;
      }

      case "end_turn": {
        if (state.phase !== "awaiting_action") return "INVALID_PHASE";
        if (state.actingUnitId !== command.actorId) return "NOT_ACTING_UNIT";
        return null;
      }

      case "surrender":
        return state.teams.some((team) => team.sideId === command.sideId) ? null : "UNKNOWN_SIDE";

      default:
        return "INVALID_COMMAND";
    }
  }

  /**
   * Turn start (turn order): consume the turn bar (turn order system), continuous damage / regeneration, turn-start
   * hooks and passives, then skip the turn for hard crowd control or when no skill is usable.
   */
  private handleStartTurn(ctx: DispatchContext, actorId: string): void {
    const state = ctx.state;
    const actor = getBattleUnit(state, actorId);
    if (!actor) return;

    const turnOrder = getTurnOrderSystem(ctx.formulas);
    const extraTurn = readMetadataString(state.metadata, EXTRA_TURN_METADATA_KEY) === actorId;
    delete state.metadata[EXTRA_TURN_METADATA_KEY];
    delete state.metadata[PENDING_EXTRA_TURN_METADATA_KEY];
    state.turn += 1;
    state.round = turnOrder.resolveRound(state);
    state.actingUnitId = actorId;
    setBattlePhase(state, "awaiting_action", ctx.events);

    ctx.events.push({
      type: "turn_started",
      battleId: state.battleId,
      actorId,
      sideId: actor.sideId,
      turn: state.turn,
      round: state.round,
    });

    ctx.events.push(...turnOrder.onTurnStarted(state, actor, extraTurn));

    const periodic = tickStatusesStartOfTurn(actor);
    ctx.events.push(...periodic.events);
    this.handleOutOfSkillDeaths(ctx, periodic.events);
    ctx.events.push(...refreshPassiveAuras(state));

    // A unit killed by continuous damage loses its turn even if a passive revives it.
    const diedAtTurnStart = periodic.events.some((event) => event.type === "unit_died" && event.targetId === actor.unitId);
    if (diedAtTurnStart || actor.currentHp <= 0) {
      ctx.events.push({ type: "turn_skipped", battleId: state.battleId, actorId, reason: "died" });
      this.completeTurn(ctx, actor, "died");
      return;
    }

    ctx.events.push(...(this.ruleset.onTurnStarted?.(state, actor) ?? []));
    for (const system of this.runtimeSystems) {
      if (!system.onTurnStarted) continue;
      ctx.events.push(...system.onTurnStarted({
        state,
        actor,
        rng: ctx.rng,
        formulas: ctx.formulas,
        resolveEffectBundle: (request) => this.resolveEffectBundle(ctx, request),
      }));
    }

    if (actor.currentHp <= 0) {
      ctx.events.push({ type: "turn_skipped", battleId: state.battleId, actorId, reason: "died" });
      this.completeTurn(ctx, actor, "died");
      return;
    }

    if (buildStatusSummary(actor).cannotAct) {
      ctx.events.push({ type: "turn_skipped", battleId: state.battleId, actorId, reason: "control" });
      this.completeTurn(ctx, actor, "control");
      return;
    }

    if (listUsableSkills(state, actor).length === 0) {
      ctx.events.push({ type: "turn_skipped", battleId: state.battleId, actorId, reason: "no_action" });
      this.completeTurn(ctx, actor, "no_action");
    }
  }

  private handleUseSkill(ctx: DispatchContext, command: UseSkillCommand): void {
    const state = ctx.state;
    const actor = getBattleUnit(state, command.actorId);
    if (!actor) return;

    const skill = findUnitSkill(actor, command.skillId);
    if (!skill) return;

    const validation = validateSkillTarget(state, actor, skill, command.targetId);
    if (!validation.ok) return;

    const primaryTarget = validation.primaryTarget;
    const skillLevel = getUnitSkillLevel(actor, skill);
    const targets = resolveSkillTargets(state, actor, primaryTarget, skill, ctx.rng);

    setBattlePhase(state, "resolving_action", ctx.events);
    ctx.events.push({
      type: "skill_used",
      battleId: state.battleId,
      actorId: actor.unitId,
      targetIds: targets.map((target) => target.unitId),
      skillId: skill.id,
      skillLevel,
      primaryTargetId: primaryTarget.unitId,
      trigger: "turn_action",
    });

    const cooldown = getUnitSkillCooldown(actor, skill);
    if (cooldown > 0) {
      const previous = actor.cooldowns[skill.id] ?? 0;
      actor.cooldowns[skill.id] = cooldown;
      ctx.events.push({
        type: "cooldown_changed",
        targetId: actor.unitId,
        skillId: skill.id,
        amount: cooldown - previous,
        currentCooldown: cooldown,
      });
    }

    const signals = createSkillSignals(true, true);
    this.runSkillStartingSystems(ctx, actor, primaryTarget, targets, skill, skillLevel, "turn_action");
    const skillEvents = this.executeSkill(ctx, actor, primaryTarget, targets, skill, skillLevel, { signals });
    this.recordExtraTurn(ctx, actor, signals, { actorId: actor.unitId, source: "skill", skillId: skill.id });
    this.runSkillResolvedSystems(ctx, actor, primaryTarget, targets, skill, skillLevel, skillEvents, "turn_action");
    const followUpEvents = this.resolveSignalledFollowUps(ctx, actor, primaryTarget, skill, skillLevel, signals);
    this.resolveCounterattacks(ctx, actor, [...skillEvents, ...followUpEvents]);
    this.completeTurn(ctx, actor, "skill_resolved");
  }

  /** Stores a succeeded ExtraTurn effect of the acting unit; it is granted when the turn ends. */
  private recordExtraTurn(ctx: DispatchContext, actor: BattleUnitState, signals: SkillSignals, pending: PendingExtraTurn): void {
    if (!signals.extraTurn || ctx.state.actingUnitId !== actor.unitId) return;
    if (readPendingExtraTurn(ctx.state.metadata)?.actorId === actor.unitId) return;
    const stored: Record<string, unknown> = { actorId: pending.actorId, source: pending.source };
    if (pending.skillId) stored.skillId = pending.skillId;
    if (pending.passiveId) stored.passiveId = pending.passiveId;
    ctx.state.metadata[PENDING_EXTRA_TURN_METADATA_KEY] = stored;
  }

  /**
   * Target of a follow-up attack: the original primary target (an enemy of the attacker for enemy skills), else a
   * random living enemy of the attacker.
   */
  private resolveFollowUpTarget(ctx: DispatchContext, attacker: BattleUnitState, primaryTarget: BattleUnitState, skill: CharacterSkillDTO): BattleUnitState | null {
    const current = getBattleUnit(ctx.state, primaryTarget.unitId);
    const enemySkill = resolveSkillTargetSide(skill) === "Enemy";
    if (current && current.currentHp > 0 && (!enemySkill || current.sideId !== attacker.sideId)) return current;
    if (!enemySkill) return null;
    return pickRandomUnits(listAliveEnemyUnits(ctx.state, attacker.sideId), 1, ctx.rng)[0] ?? null;
  }

  /**
   * Follow-ups requested by the turn action's caster effects: AllyAttack (each picked ally uses its first skill),
   * then AdditionalAttack (the caster uses the same skill again, once). Follow-ups never chain. Returns the effect
   * events of the additional attack (counterattack detection).
   */
  private resolveSignalledFollowUps(
    ctx: DispatchContext,
    actor: BattleUnitState,
    primaryTarget: BattleUnitState,
    skill: CharacterSkillDTO,
    skillLevel: number,
    signals: SkillSignals
  ): BattleEvent[] {
    const effectEvents: BattleEvent[] = [];

    for (const allyId of signals.allyAttackerIds) {
      if (ctx.state.phase === "finished") break;
      const ally = getBattleUnit(ctx.state, allyId);
      const allySkill = ally?.skills[0];
      if (!ally || !allySkill || ally.currentHp <= 0 || buildStatusSummary(ally).cannotAct) continue;
      const target = this.resolveFollowUpTarget(ctx, ally, primaryTarget, allySkill);
      if (!target) continue;
      ctx.events.push(...this.resolveFollowUpSkill(ctx, {
        actor: ally,
        primaryTarget: target,
        skill: allySkill,
        triggerSource: "ally_attack",
        requesterId: actor.unitId,
      }));
    }

    if (signals.additionalAttack && actor.currentHp > 0 && ctx.state.phase !== "finished") {
      const target = this.resolveFollowUpTarget(ctx, actor, primaryTarget, skill);
      if (target) {
        ctx.events.push(...this.resolveFollowUpSkill(ctx, {
          actor,
          primaryTarget: target,
          skill,
          skillLevel,
          triggerSource: "additional_attack",
        }, effectEvents));
      }
    }

    return effectEvents;
  }

  private runSkillStartingSystems(
    ctx: DispatchContext,
    actor: BattleUnitState,
    primaryTarget: BattleUnitState,
    targets: BattleUnitState[],
    skill: CharacterSkillDTO,
    skillLevel: number,
    triggerSource: BattleRuntimeTriggerSource
  ): void {
    for (const system of this.runtimeSystems) {
      if (!system.onSkillStarting) continue;
      ctx.events.push(...system.onSkillStarting({
        state: ctx.state,
        actor,
        primaryTarget,
        targets,
        skill,
        skillLevel,
        rng: ctx.rng,
        formulas: ctx.formulas,
        triggerSource,
        resolveEffectBundle: (request) => this.resolveEffectBundle(ctx, request),
      }));
    }
  }

  /**
   * Executes the effects of a skill (or passive bundle) in order with per-effect target scope, condition and
   * the hit gating; passive auras are re-evaluated after every effect. Returns the events produced by the effects.
   */
  private executeSkill(
    ctx: DispatchContext,
    actor: BattleUnitState,
    primaryTarget: BattleUnitState,
    skillTargets: BattleUnitState[],
    skill: CharacterSkillDTO,
    skillLevel: number,
    options?: SkillExecutionOptions
  ): BattleEvent[] {
    const ledger = createSkillHitLedger();
    const produced: BattleEvent[] = [];
    const levelBonus = getSkillLevelBonus(skill, skillLevel);

    for (const effect of Array.isArray(skill.effects) ? skill.effects : []) {
      if (actor.currentHp <= 0 && !options?.allowDeadActor) break;

      const scoped = resolveEffectScopeTargets(ctx.state, actor, primaryTarget, skillTargets, effect, ctx.rng);
      const candidates = filterTargetsForEffect(effect, scoped);
      const targets: BattleUnitState[] = [];
      const repeat: Record<string, number> = {};

      for (const target of candidates) {
        if (Object.prototype.hasOwnProperty.call(repeat, target.unitId)) continue;
        if (!isEffectConditionMet(effect, target, ledger, actor, options?.conditionTarget ?? primaryTarget)) continue;
        const count = getEffectRepeatCount(effect, target, actor, ledger);
        if (count <= 0) continue;
        targets.push(target);
        repeat[target.unitId] = count;
      }

      if (targets.length === 0) continue;

      const events = this.effectRegistry.execute({
        state: ctx.state,
        actor,
        primaryTarget,
        targets,
        skill,
        effect: applySkillLevelToEffect(effect, levelBonus),
        skillLevel,
        rng: ctx.rng,
        formulas: ctx.formulas,
        ledger,
        repeat,
        passiveId: options?.passiveId ?? null,
        signals: options?.signals,
      });

      produced.push(...events);
      ctx.events.push(...events);
      ctx.events.push(...refreshPassiveAuras(ctx.state));
    }

    return produced;
  }

  private runSkillResolvedSystems(
    ctx: DispatchContext,
    actor: BattleUnitState,
    primaryTarget: BattleUnitState,
    targets: BattleUnitState[],
    skill: CharacterSkillDTO,
    skillLevel: number,
    effectEvents: BattleEvent[],
    triggerSource: BattleRuntimeTriggerSource
  ): void {
    for (const system of this.runtimeSystems) {
      if (!system.onSkillResolved) continue;
      ctx.events.push(...system.onSkillResolved({
        state: ctx.state,
        actor,
        primaryTarget,
        targets,
        skill,
        skillLevel,
        rng: ctx.rng,
        formulas: ctx.formulas,
        effectEvents,
        triggerSource,
        resolveFollowUpSkill: (request) => this.resolveFollowUpSkill(ctx, request),
        resolveEffectBundle: (request) => this.resolveEffectBundle(ctx, request),
      }));
    }
  }

  /**
   * Counterattacks: every enemy hit by the turn action counters once with its first skill when it is alive,
   * not hard-controlled and rolls its Counterattack buff chance (or, failing that, its rune counter chance).
   */
  private resolveCounterattacks(ctx: DispatchContext, attacker: BattleUnitState, skillEvents: BattleEvent[]): void {
    const processed = new Set<string>();

    for (const event of skillEvents) {
      if (event.type !== "damage_applied" || event.kind !== "attack" || event.sourceId !== attacker.unitId) continue;
      if (processed.has(event.targetId)) continue;
      processed.add(event.targetId);

      if (attacker.currentHp <= 0 || ctx.state.phase === "finished") return;

      const defender = getBattleUnit(ctx.state, event.targetId);
      if (!defender || defender.currentHp <= 0 || defender.sideId === attacker.sideId) continue;

      const summary = buildStatusSummary(defender);
      if (summary.cannotAct) continue;

      const counterSkill = defender.skills[0];
      if (!counterSkill || resolveSkillTargetSide(counterSkill) !== "Enemy") continue;

      const rng = () => ctx.rng.next();
      const runeChance = readBattleRuneSetEffects(defender.metadata?.runeSetEffects).counterattackChance;
      const counters = rollChance(summary.counterattackChance, rng) || rollChance(runeChance, rng);
      if (!counters) continue;

      ctx.events.push(...this.resolveFollowUpSkill(ctx, {
        actor: defender,
        primaryTarget: attacker,
        skill: counterSkill,
        triggerSource: "counterattack",
      }));
    }
  }

  /**
   * Turn end (turn order): turn-ending systems (OnTurnEnd passives), duration tick and expirations (bomb detonation),
   * cooldowns -1, `turn_ended`, ruleset hook, battle resolution, then — when the battle continues — the pending
   * ExtraTurn effect and the turn-completed systems (Violent).
   */
  private completeTurn(ctx: DispatchContext, actor: BattleUnitState, reason: BattleTurnEndReason): void {
    const state = ctx.state;

    if (reason !== "died" && actor.currentHp > 0) {
      for (const system of this.runtimeSystems) {
        if (!system.onTurnEnding) continue;
        ctx.events.push(...system.onTurnEnding({
          state,
          actor,
          reason,
          rng: ctx.rng,
          formulas: ctx.formulas,
          resolveEffectBundle: (request) => this.resolveEffectBundle(ctx, request),
        }));
      }
    }

    if (reason !== "died" && actor.currentHp > 0) {
      const tick = tickStatusesEndOfTurn(actor, { formulas: ctx.formulas, rng: () => ctx.rng.next() });
      ctx.events.push(...tick.events);
      this.handleOutOfSkillDeaths(ctx, tick.events);
      ctx.events.push(...refreshPassiveAuras(state));
    }

    if (reason !== "died" && actor.currentHp > 0) ctx.events.push(...this.reduceCooldowns(actor));

    state.actingUnitId = null;
    ctx.events.push({
      type: "turn_ended",
      battleId: state.battleId,
      actorId: actor.unitId,
      reason,
    });

    ctx.events.push(...(this.ruleset.onTurnEnded?.(state, actor) ?? []));
    if (state.phase !== "finished") setBattlePhase(state, "waiting_for_turn", ctx.events);
    const pending = readPendingExtraTurn(state.metadata);
    delete state.metadata[PENDING_EXTRA_TURN_METADATA_KEY];
    this.resolveBattleState(ctx);
    if (state.phase === "finished") return;

    if (pending && pending.actorId === actor.unitId && reason === "skill_resolved" && actor.currentHp > 0) {
      ctx.events.push({
        type: "extra_turn_granted",
        battleId: state.battleId,
        actorId: actor.unitId,
        source: pending.source,
        ...(pending.skillId ? { skillId: pending.skillId } : {}),
        ...(pending.passiveId ? { passiveId: pending.passiveId } : {}),
      });
      ctx.events.push(...getTurnOrderSystem(ctx.formulas).grantExtraTurn(state, actor, ctx.formulas));
    }

    for (const system of this.runtimeSystems) {
      if (!system.onTurnCompleted) continue;
      ctx.events.push(...system.onTurnCompleted({
        state,
        actor,
        reason,
        rng: ctx.rng,
        formulas: ctx.formulas,
      }));
    }
  }

  private reduceCooldowns(actor: BattleUnitState): BattleEvent[] {
    const events: BattleEvent[] = [];
    const order: string[] = actor.skills.map((skill) => skill.id);
    for (const skillId of Object.keys(actor.cooldowns)) {
      if (!order.includes(skillId)) order.push(skillId);
    }

    for (const skillId of order) {
      const current = actor.cooldowns[skillId] ?? 0;
      if (current <= 0) continue;
      const next = current - 1;
      actor.cooldowns[skillId] = next;
      events.push({
        type: "cooldown_changed",
        targetId: actor.unitId,
        skillId,
        amount: -1,
        currentCooldown: next,
      });
    }

    return events;
  }

  /** Runs `onUnitDied` hooks for deaths caused outside skill resolution (continuous damage, bombs). */
  private handleOutOfSkillDeaths(ctx: DispatchContext, events: BattleEvent[]): void {
    for (const event of events) {
      if (event.type !== "unit_died") continue;
      ctx.events.push(...refreshPassiveAuras(ctx.state));
      const unit = getBattleUnit(ctx.state, event.targetId);
      if (!unit) continue;
      const killer = event.sourceId ? getBattleUnit(ctx.state, event.sourceId) ?? null : null;

      for (const system of this.runtimeSystems) {
        if (!system.onUnitDied) continue;
        ctx.events.push(...system.onUnitDied({
          state: ctx.state,
          unit,
          killer,
          cause: event.cause as UnitDeathCause,
          rng: ctx.rng,
          formulas: ctx.formulas,
          resolveEffectBundle: (request) => this.resolveEffectBundle(ctx, request),
        }));
      }
    }
  }

  private handleSurrender(ctx: DispatchContext, sideId: string): void {
    const winnerSideId = getEnemySideIds(ctx.state, sideId)
      .find((enemySideId) => listAliveUnitsBySide(ctx.state, enemySideId).length > 0)
      ?? null;
    finishBattle(ctx.state, winnerSideId, "surrender", ctx.events);
  }

  private resolveBattleState(ctx: DispatchContext): void {
    if (ctx.state.phase === "finished") return;
    const resolution = this.ruleset.resolveBattle(ctx.state);
    if (!resolution.finished) return;
    finishBattle(ctx.state, resolution.winnerSideId, resolution.reason, ctx.events);
  }

  /**
   * Resolves a follow-up skill (counterattack, additional attack, ally attack): trigger event, `skill_used`,
   * BeforeAttack systems, the effects (caster effects disabled: follow-ups never chain) and the skill-resolved
   * systems. No cooldown is set. The follow-up's effect events are also appended to `effectSink` when given.
   */
  private resolveFollowUpSkill(ctx: DispatchContext, request: BattleRuntimeFollowUpSkillRequest, effectSink?: BattleEvent[]): BattleEvent[] {
    const state = ctx.state;
    const actor = getBattleUnit(state, request.actor.unitId);
    const primaryTarget = getBattleUnit(state, request.primaryTarget.unitId);
    if (!actor || !primaryTarget || actor.currentHp <= 0 || primaryTarget.currentHp <= 0) return [];

    const skill = request.skill ?? actor.skills[0];
    if (!skill) return [];

    const skillLevel = request.skillLevel ?? getUnitSkillLevel(actor, skill);
    const sink = ctx.events;
    const local: BattleEvent[] = [];
    ctx.events = local;

    if (request.triggerSource === "counterattack") {
      local.push({
        type: "counterattack_triggered",
        battleId: state.battleId,
        actorId: actor.unitId,
        targetId: primaryTarget.unitId,
        skillId: skill.id,
      });
    } else if (request.triggerSource === "additional_attack") {
      local.push({
        type: "additional_attack_triggered",
        battleId: state.battleId,
        actorId: actor.unitId,
        targetId: primaryTarget.unitId,
        skillId: skill.id,
      });
    } else if (request.triggerSource === "ally_attack") {
      local.push({
        type: "ally_attack_triggered",
        battleId: state.battleId,
        actorId: actor.unitId,
        sourceId: request.requesterId ?? actor.unitId,
        targetId: primaryTarget.unitId,
        skillId: skill.id,
      });
    }

    const targets = resolveSkillTargets(state, actor, primaryTarget, skill, ctx.rng);
    local.push({
      type: "skill_used",
      battleId: state.battleId,
      actorId: actor.unitId,
      targetIds: targets.map((target) => target.unitId),
      skillId: skill.id,
      skillLevel,
      primaryTargetId: primaryTarget.unitId,
      trigger: request.triggerSource,
    });

    this.runSkillStartingSystems(ctx, actor, primaryTarget, targets, skill, skillLevel, request.triggerSource);
    const skillEvents = this.executeSkill(ctx, actor, primaryTarget, targets, skill, skillLevel, { signals: createSkillSignals(false, false) });
    effectSink?.push(...skillEvents);
    this.runSkillResolvedSystems(ctx, actor, primaryTarget, targets, skill, skillLevel, skillEvents, request.triggerSource);

    ctx.events = sink;
    return local;
  }

  private resolveEffectBundle(ctx: DispatchContext, request: BattleRuntimeEffectBundleRequest): BattleEvent[] {
    const state = ctx.state;
    const actor = getBattleUnit(state, request.actor.unitId);
    const primaryTarget = getBattleUnit(state, request.primaryTarget.unitId);
    if (!actor || !primaryTarget) return [];

    const targets = Array.isArray(request.targets) && request.targets.length > 0
      ? request.targets
          .map((target) => getBattleUnit(state, target.unitId))
          .filter(Boolean) as BattleUnitState[]
      : [primaryTarget];

    if (targets.length === 0) return [];

    const syntheticSkill: CharacterSkillDTO = {
      id: request.sourceId,
      name: request.sourceName ?? null,
      maxSkillLevel: 1,
      cooldownByLevel: [0],
      effects: request.effects,
    };

    const sink = ctx.events;
    const local: BattleEvent[] = [];
    ctx.events = local;
    const signals = createSkillSignals(state.actingUnitId === actor.unitId, false);
    this.executeSkill(ctx, actor, primaryTarget, targets, syntheticSkill, request.skillLevel ?? 1, {
      passiveId: request.passiveId ?? null,
      allowDeadActor: true,
      signals,
      conditionTarget: request.conditionTarget ? getBattleUnit(state, request.conditionTarget.unitId) ?? null : null,
    });
    this.recordExtraTurn(ctx, actor, signals, {
      actorId: actor.unitId,
      source: "passive",
      passiveId: request.passiveId ?? request.sourceId,
    });
    ctx.events = sink;
    return local;
  }
}

