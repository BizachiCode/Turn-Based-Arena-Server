import { BattleEngine } from "./battle-engine";
import { decideAiCommand, type BattleAiDecisionKind, type BattleAiOptions } from "./battle-ai";
import { createBattleUnitState, type CreateBattleUnitInput } from "./battle-state-factory";
import { refreshPassiveAuras } from "./passive-auras";
import { EXTRA_TURN_METADATA_KEY, getTurnOrderSystem, type TurnOrderPreview, type TurnOrderSystem } from "./turn-order-system";
import type { BattleCommand } from "../domain/battle-command";
import type { BattleEvent } from "../domain/battle-event";
import type { BattlePhase, BattleState, BattleUnitState } from "../domain/battle-state";
import { cloneBattleState, getTeam, listAliveUnitsBySide, listUnitsBySide } from "../domain/battle-state-utils";
import { PveBattleRuleset } from "../rulesets/pve-battle-ruleset";
import { buildStatusSummary } from "../statuses/status-rules";
import {
  findUnitSkill,
  getForcedTargetId,
  getSkillUsabilityFailure,
  listUsableSkills,
  listValidTargetIds,
  resolveSkillTargetSide,
  validateSkillTarget,
  type ResolvedSkillTargetSide,
} from "../skills/skill-rules";

const MAX_AUTO_STEPS = 1000;
/** Time advances (ATB fills, rounds, phases) tried before a turn start; a stalled order stops the session. */
const MAX_ADVANCES_PER_TURN = 16;

/** One skill of the active player unit, as the client should present it. */
export type BattleSkillOption = {
  skillId: string;
  usable: boolean;
  /** Why the skill is not usable (`SKILL_ON_COOLDOWN`, `SILENCED`, `PROVOKED`, `NO_TARGET`), null when usable. */
  reason: string | null;
  cooldown: number;
  targetSide: ResolvedSkillTargetSide;
  /** Valid primary target ids (empty when not usable). */
  targetIds: string[];
};

/** Action options of the unit awaiting player input (null when the session is not waiting for the player). */
export type BattleActionOptions = {
  actorId: string;
  /** Provoker id when the unit is provoked (only skill 1 on this target is accepted). */
  forcedTargetId: string | null;
  skills: BattleSkillOption[];
};

export type PveBattleSessionStepResult = {
  accepted: boolean;
  state: BattleState;
  events: BattleEvent[];
  awaitingPlayerInput: boolean;
  activeUnitId: string | null;
  activeSideId: string | null;
  currentWaveIndex: number;
  totalWaves: number;
  error?: string;
  phase: BattlePhase;
  turn: number;
  round: number;
  finished: boolean;
  winnerSideId: string | null;
  finishedReason: string | null;
  /** True/false once finished (player side won / lost or drew), null while running. */
  victory: boolean | null;
  /**
   * Options of the unit awaiting player input. TeamPhase while the player picks the next unit: the options of the
   * unit the AI would pick (also the first entry of `actorOptions`).
   */
  actionOptions: BattleActionOptions | null;
  /**
   * TeamPhase manual play: the player's ready units the next command may use (one entry per unit, AI order); a
   * `usePlayerSkill` for any of them starts that unit's turn. Null when the next actor is not the player's choice.
   */
  actorOptions: BattleActionOptions[] | null;
  /** Upcoming actors of the configured turn order system (see docs/BATTLE_RULES.md "Turn order"). */
  turnOrder: TurnOrderPreview;
};

/** A player-level command recorded for replays. */
export type PveBattleSessionCommandRecord =
  | { type: "skill"; actorId: string; skillId: string; targetId: string }
  | { type: "auto" }
  | { type: "surrender" };

export type PveBattleSessionReplay = {
  initialState: BattleState;
  pendingEnemyWaves: BattleUnitState[][];
  playerSideId: string;
  enemySideId: string;
  currentWaveIndex: number;
  totalWaves: number;
  commands: PveBattleSessionCommandRecord[];
};

export type PveBattleSessionInput = {
  state: BattleState;
  /** Pending enemy waves, as unit inputs (stats computed on construction) or ready unit states. */
  pendingEnemyWaves: Array<Array<CreateBattleUnitInput | BattleUnitState>>;
  playerSideId: string;
  enemySideId: string;
  currentWaveIndex: number;
  totalWaves: number;
  /** Engine to use (defaults to a PvE engine with default formulas and no runtime systems). */
  engine?: BattleEngine;
  aiOptions?: BattleAiOptions;
};

function isUnitState(entry: CreateBattleUnitInput | BattleUnitState): entry is BattleUnitState {
  return typeof (entry as BattleUnitState).currentHp === "number" && !!(entry as BattleUnitState).stats;
}

/**
 * Server-side PvE session: drives the engine (turn bars, AI turns, waves) until the player must act or the
 * battle ends. Every public method returns the same step result shape.
 * Waves: when the enemy side is wiped and a wave is pending, the dead enemies are removed, every turn bar
 * resets to 0 (survivors keep their statuses and cooldowns) and the next wave spawns.
 */
export class PveBattleSession {
  protected state: BattleState;
  protected readonly engine: BattleEngine;
  private readonly pendingEnemyWaves: BattleUnitState[][];
  private readonly playerSideId: string;
  private readonly enemySideId: string;
  private currentWaveIndex: number;
  private readonly totalWaves: number;
  private readonly aiOptions?: BattleAiOptions;
  private readonly replay: PveBattleSessionReplay;
  private lastAiDecision: BattleAiDecisionKind | null = null;

  constructor(input: PveBattleSessionInput) {
    this.engine = input.engine ?? new BattleEngine(new PveBattleRuleset());
    this.state = input.state;
    this.pendingEnemyWaves = (input.pendingEnemyWaves ?? []).map((wave) =>
      wave.map((entry) => isUnitState(entry) ? structuredClone(entry) : createBattleUnitState(entry)));
    this.playerSideId = input.playerSideId;
    this.enemySideId = input.enemySideId;
    this.currentWaveIndex = input.currentWaveIndex;
    this.totalWaves = input.totalWaves;
    this.aiOptions = input.aiOptions;

    if (!this.state.metadata) this.state.metadata = {};
    this.state.metadata.pendingEnemyWaveCount = this.pendingEnemyWaves.length;

    this.replay = {
      initialState: cloneBattleState(this.state),
      pendingEnemyWaves: structuredClone(this.pendingEnemyWaves),
      playerSideId: this.playerSideId,
      enemySideId: this.enemySideId,
      currentWaveIndex: this.currentWaveIndex,
      totalWaves: this.totalWaves,
      commands: [],
    };
  }

  get battleId(): string {
    return this.state.battleId;
  }

  getState(): BattleState {
    return this.state;
  }

  /** Initial state, waves and player commands: replaying them on a new session reproduces the battle. */
  getReplay(): PveBattleSessionReplay {
    return structuredClone(this.replay);
  }

  /** Kind of the last AI decision (debugging). */
  getLastAiDecision(): BattleAiDecisionKind | null {
    return this.lastAiDecision;
  }

  start(): PveBattleSessionStepResult {
    const firstWaveEnemyIds = listUnitsBySide(this.state, this.enemySideId).map((unit) => unit.unitId);
    const started = this.engine.start(this.state);
    if (!started.accepted) return this.finalize(started.events, false, started.error);

    this.state = started.state;
    const events: BattleEvent[] = [
      {
        type: "wave_started",
        battleId: this.state.battleId,
        waveIndex: this.currentWaveIndex,
        totalWaves: this.totalWaves,
        spawnedUnitIds: firstWaveEnemyIds,
      },
      ...started.events,
    ];

    return this.advance(events);
  }

  usePlayerSkill(command: {
    actorId: string;
    skillId: string;
    targetId: string;
  }): PveBattleSessionStepResult {
    const actor = this.state.units[command.actorId];
    if (!actor || actor.sideId !== this.playerSideId) {
      return this.finalize([], false, "INVALID_PLAYER_ACTOR");
    }

    const selectable = this.listSelectableActors();
    if (selectable.length > 0) return this.useSelectedActorSkill(command, selectable);

    const result = this.engine.dispatch(this.state, {
      type: "use_skill",
      actorId: command.actorId,
      skillId: command.skillId,
      targetId: command.targetId,
    });

    if (!result.accepted) return this.finalize(result.events, false, result.error);

    this.replay.commands.push({ type: "skill", actorId: command.actorId, skillId: command.skillId, targetId: command.targetId });
    this.state = result.state;
    return this.advance(result.events);
  }

  /**
   * TeamPhase: starts the turn of the unit the player picked, then uses the skill. The command is validated before
   * the turn starts; when the turn start skips the unit (e.g. killed by continuous damage) the skill is dropped.
   */
  private useSelectedActorSkill(
    command: { actorId: string; skillId: string; targetId: string },
    selectable: BattleUnitState[]
  ): PveBattleSessionStepResult {
    const actor = selectable.find((unit) => unit.unitId === command.actorId);
    if (!actor) return this.finalize([], false, "ACTOR_NOT_READY");
    const skill = findUnitSkill(actor, command.skillId);
    if (!skill) return this.finalize([], false, "UNKNOWN_SKILL");
    const failure = getSkillUsabilityFailure(this.state, actor, skill);
    if (failure) return this.finalize([], false, failure);
    const target = validateSkillTarget(this.state, actor, skill, command.targetId);
    if ("reason" in target) return this.finalize([], false, target.reason);

    const started = this.engine.dispatch(this.state, { type: "start_turn", actorId: actor.unitId });
    if (!started.accepted) return this.finalize(started.events, false, started.error);
    this.replay.commands.push({ type: "skill", actorId: command.actorId, skillId: command.skillId, targetId: command.targetId });
    this.state = started.state;
    const events = [...started.events];
    if (this.state.phase !== "awaiting_action" || this.state.actingUnitId !== actor.unitId) return this.advance(events);

    const result = this.engine.dispatch(this.state, {
      type: "use_skill",
      actorId: command.actorId,
      skillId: command.skillId,
      targetId: command.targetId,
    });
    events.push(...result.events);
    if (!result.accepted) return this.finalize(events, false, result.error);
    this.state = result.state;
    return this.advance(events);
  }

  /** Lets the server AI choose the command of the player unit that is awaiting input (auto-play). */
  usePlayerAuto(): PveBattleSessionStepResult {
    if (!this.isAwaitingPlayer()) {
      // A step that ran out of its step budget (AUTO_ADVANCE_STALLED, e.g. a very long chain of AI extra turns) left
      // the battle between turns: auto-play resumes it instead of leaving it idle.
      if (this.state.phase === "finished" || this.state.phase === "created") return this.finalize([], false, "NOT_AWAITING_PLAYER_INPUT");
      this.replay.commands.push({ type: "auto" });
      return this.advance([]);
    }

    const events: BattleEvent[] = [];
    const selected = this.listSelectableActors()[0];
    if (selected) {
      const started = this.engine.dispatch(this.state, { type: "start_turn", actorId: selected.unitId });
      if (!started.accepted) return this.finalize(started.events, false, started.error);
      this.state = started.state;
      events.push(...started.events);
      if (this.state.phase !== "awaiting_action" || this.state.actingUnitId !== selected.unitId) {
        this.replay.commands.push({ type: "auto" });
        return this.advance(events);
      }
    }

    const actorId = this.state.actingUnitId as string;
    const command = this.decide(actorId);
    const result = this.engine.dispatch(this.state, command);
    events.push(...result.events);
    if (!result.accepted) return this.finalize(events, false, result.error);

    this.replay.commands.push({ type: "auto" });
    this.state = result.state;
    return this.advance(events);
  }

  /** The player gives up: the battle ends immediately as a defeat. */
  surrender(): PveBattleSessionStepResult {
    const result = this.engine.dispatch(this.state, { type: "surrender", sideId: this.playerSideId });
    if (!result.accepted) return this.finalize(result.events, false, result.error);

    this.replay.commands.push({ type: "surrender" });
    this.state = result.state;
    return this.finalize(result.events, true, undefined);
  }

  /**
   * Action options of the active player unit (null when not awaiting player input). TeamPhase while the player picks
   * the next unit: the options of the unit the AI would pick.
   */
  getActionOptions(): BattleActionOptions | null {
    if (!this.isAwaitingPlayer()) return null;
    const selected = this.listSelectableActors()[0];
    const actor = selected ?? this.state.units[this.state.actingUnitId as string];
    if (!actor) return null;
    return this.buildActionOptions(actor);
  }

  /** TeamPhase manual play: options of every player unit the next command may use (null otherwise). */
  getActorOptions(): BattleActionOptions[] | null {
    const selectable = this.listSelectableActors();
    return selectable.length > 0 ? selectable.map((unit) => this.buildActionOptions(unit)) : null;
  }

  private buildActionOptions(actor: BattleUnitState): BattleActionOptions {
    const skills: BattleSkillOption[] = actor.skills.map((skill) => {
      const failure = getSkillUsabilityFailure(this.state, actor, skill);
      const targetIds = failure ? [] : listValidTargetIds(this.state, actor, skill);
      return {
        skillId: skill.id,
        usable: !failure && targetIds.length > 0,
        reason: failure ?? (targetIds.length === 0 ? "NO_TARGET" : null),
        cooldown: actor.cooldowns[skill.id] ?? 0,
        targetSide: resolveSkillTargetSide(skill),
        targetIds,
      };
    });

    return { actorId: actor.unitId, forcedTargetId: getForcedTargetId(this.state, actor), skills };
  }

  private get turnOrder(): TurnOrderSystem {
    return getTurnOrderSystem(this.engine.getFormulas());
  }

  /** Ready player units the player may pick from (TeamPhase), when every one of them can act. */
  private listSelectableActors(): BattleUnitState[] {
    const selectable = this.turnOrder.listSelectableActors(this.state, this.playerSideId);
    return selectable.every((unit) => this.canAct(unit)) ? selectable : [];
  }

  private canAct(unit: BattleUnitState): boolean {
    return !buildStatusSummary(unit).cannotAct && listUsableSkills(this.state, unit).length > 0;
  }

  /** `turn_order` event of the round modes (AttackBar keeps its attack bar events only). */
  private turnOrderEvent(): BattleEvent[] {
    if (this.turnOrder.mode === "AttackBar") return [];
    const preview = this.turnOrder.preview(this.state, this.engine.getFormulas());
    return [{
      type: "turn_order",
      battleId: this.state.battleId,
      round: preview.round,
      sideId: preview.sideId,
      actorIds: preview.actorIds,
      nextActorIds: preview.nextActorIds,
    }];
  }

  private decide(actorId: string): BattleCommand {
    const decision = decideAiCommand(this.state, actorId, this.engine.getFormulas(), this.aiOptions);
    this.lastAiDecision = decision.kind;
    return decision.command;
  }

  private isAwaitingPlayer(): boolean {
    if (this.listSelectableActors().length > 0) return true;
    if (this.state.phase !== "awaiting_action" || !this.state.actingUnitId) return false;
    return this.state.units[this.state.actingUnitId]?.sideId === this.playerSideId;
  }

  private advance(seedEvents: BattleEvent[]): PveBattleSessionStepResult {
    const events = [...seedEvents];
    let accepted = true;
    let error: string | undefined;

    for (let step = 0; step < MAX_AUTO_STEPS; step += 1) {
      if (this.state.phase === "finished") break;

      if (this.shouldSpawnNextWave()) {
        events.push(...this.spawnNextWave());
        continue;
      }

      if (this.state.phase === "waiting_for_turn") {
        const turnOrder = this.turnOrder;
        let nextActor = turnOrder.selectNextActor(this.state);
        for (let advances = 0; !nextActor && advances < MAX_ADVANCES_PER_TURN; advances++) {
          const advanceEvents = turnOrder.advance(this.state, this.engine.getFormulas());
          if (advanceEvents.length === 0) break;
          events.push(...advanceEvents);
          nextActor = turnOrder.selectNextActor(this.state);
        }
        if (!nextActor) break;

        // TeamPhase: the player picks among the ready units that can act; the others take their (skipped) turn first.
        const candidates = turnOrder.listSelectableActors(this.state, this.playerSideId);
        if (candidates.length > 0) {
          const blocked = candidates.find((unit) => !this.canAct(unit));
          if (!blocked) {
            events.push(...this.turnOrderEvent());
            return this.finalize(events, accepted, error);
          }
          nextActor = blocked;
        }

        events.push(...this.turnOrderEvent());

        const turnStarted = this.engine.dispatch(this.state, { type: "start_turn", actorId: nextActor.unitId });
        events.push(...turnStarted.events);
        if (!turnStarted.accepted) {
          accepted = false;
          error = turnStarted.error ?? "START_TURN_FAILED";
          break;
        }
        this.state = turnStarted.state;
        continue;
      }

      if (this.state.phase === "awaiting_action") {
        const actorId = this.state.actingUnitId;
        const actor = actorId ? this.state.units[actorId] : null;
        if (!actor) break;
        if (actor.sideId === this.playerSideId) return this.finalize(events, accepted, error);

        const resolved = this.engine.dispatch(this.state, this.decide(actor.unitId));
        events.push(...resolved.events);
        if (!resolved.accepted) {
          accepted = false;
          error = resolved.error ?? "AI_COMMAND_REJECTED";
          break;
        }
        this.state = resolved.state;
        continue;
      }

      break;
    }

    if (!error && this.state.phase !== "finished" && this.state.phase !== "awaiting_action" && !this.isAwaitingPlayer()) {
      error = "AUTO_ADVANCE_STALLED";
      accepted = false;
    }

    return this.finalize(events, accepted, error);
  }

  private shouldSpawnNextWave(): boolean {
    return this.pendingEnemyWaves.length > 0
      && this.state.phase === "waiting_for_turn"
      && listAliveUnitsBySide(this.state, this.enemySideId).length === 0;
  }

  private spawnNextWave(): BattleEvent[] {
    const nextWave = this.pendingEnemyWaves.shift();
    if (!nextWave) return [];

    const events: BattleEvent[] = [];
    const previousWaveIndex = this.currentWaveIndex;
    this.currentWaveIndex += 1;

    let team = getTeam(this.state, this.enemySideId);
    if (!team) {
      team = { sideId: this.enemySideId, unitIds: [], isPlayerControlled: false, metadata: {} };
      this.state.teams.push(team);
    }

    const removedUnitIds = team.unitIds.filter((unitId) => (this.state.units[unitId]?.currentHp ?? 0) <= 0);
    for (const unitId of removedUnitIds) delete this.state.units[unitId];
    team.unitIds = team.unitIds.filter((unitId) => !removedUnitIds.includes(unitId));

    events.push({
      type: "wave_cleared",
      battleId: this.state.battleId,
      waveIndex: previousWaveIndex,
      sideId: this.enemySideId,
      removedUnitIds,
    });

    for (const unit of listAliveUnitsBySide(this.state, this.playerSideId)) {
      if (unit.turnBar === 0) continue;
      const previous = unit.turnBar;
      unit.turnBar = 0;
      events.push({ type: "turn_bar_changed", targetId: unit.unitId, amount: -previous, currentTurnBar: 0 });
    }
    delete this.state.metadata[EXTRA_TURN_METADATA_KEY];
    this.turnOrder.onWaveStarted(this.state);

    const turnThreshold = this.engine.getFormulas().timing.defaultTurnThreshold;
    const spawnedUnitIds: string[] = [];
    for (const template of nextWave) {
      const unit = structuredClone(template);
      unit.turnThreshold = turnThreshold;
      unit.turnBar = 0;
      this.state.units[unit.unitId] = unit;
      team.unitIds.push(unit.unitId);
      spawnedUnitIds.push(unit.unitId);
    }

    this.state.metadata.currentWaveIndex = this.currentWaveIndex;
    this.state.metadata.pendingEnemyWaveCount = this.pendingEnemyWaves.length;

    events.push({
      type: "wave_started",
      battleId: this.state.battleId,
      waveIndex: this.currentWaveIndex,
      totalWaves: this.totalWaves,
      spawnedUnitIds,
    });
    events.push(...refreshPassiveAuras(this.state));

    return events;
  }

  private finalize(events: BattleEvent[], accepted: boolean, error: string | undefined): PveBattleSessionStepResult {
    const activeSideId = this.state.actingUnitId ? this.state.units[this.state.actingUnitId]?.sideId ?? null : null;
    const finished = this.state.phase === "finished";
    const result: PveBattleSessionStepResult = {
      accepted,
      state: this.state,
      events,
      awaitingPlayerInput: this.isAwaitingPlayer(),
      activeUnitId: this.state.actingUnitId,
      activeSideId,
      currentWaveIndex: this.currentWaveIndex,
      totalWaves: this.totalWaves,
      phase: this.state.phase,
      turn: this.state.turn,
      round: this.state.round,
      finished,
      winnerSideId: this.state.winnerSideId,
      finishedReason: this.state.finishedReason,
      victory: finished ? this.state.winnerSideId === this.playerSideId : null,
      actionOptions: this.getActionOptions(),
      actorOptions: this.getActorOptions(),
      turnOrder: this.turnOrder.preview(this.state, this.engine.getFormulas()),
    };
    if (error !== undefined) result.error = error;
    return result;
  }
}
