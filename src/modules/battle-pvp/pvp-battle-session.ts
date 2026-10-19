// Real-time PvP session: two human sides on the battle-core engine. The engine (turn order, skills, passives,
// statuses) is the PvE one; this session only decides WHO must act: it advances time until a unit of either side
// must act (or, in TeamPhase, a side must pick its next unit) and waits for that side's player. The AI only plays when
// the player asks for auto, the turn timer runs out or the player is disconnected (the room decides).
// Server only: the offline backend has no real-time PvP, so this is not part of the battle-core parity port.

import {
  BattleEngine,
  buildStatusSummary,
  cloneBattleState,
  decideAiCommand,
  findUnitSkill,
  getForcedTargetId,
  getSkillUsabilityFailure,
  getTurnOrderSystem,
  listUsableSkills,
  listValidTargetIds,
  resolveSkillTargetSide,
  validateSkillTarget,
  type BattleActionOptions,
  type BattleAiOptions,
  type BattleCommand,
  type BattleEvent,
  type BattlePhase,
  type BattleSkillOption,
  type BattleState,
  type BattleUnitState,
  type TurnOrderPreview,
  type TurnOrderSystem,
} from "../battle-core/index.js";

const MAX_AUTO_STEPS = 1000;
const MAX_ADVANCES_PER_TURN = 16;

export type PvpCommandRecord =
  | { sideId: string; type: "skill"; actorId: string; skillId: string; targetId: string }
  | { sideId: string; type: "auto" }
  | { sideId: string; type: "surrender" };

/** One step of the battle, seen by nobody in particular (the room builds each player's frame from it). */
export type PvpStepResult = {
  accepted: boolean;
  error?: string;
  /** Increases with every accepted step (clients drop frames they already have). */
  seq: number;
  state: BattleState;
  events: BattleEvent[];
  phase: BattlePhase;
  turn: number;
  round: number;
  finished: boolean;
  winnerSideId: string | null;
  finishedReason: string | null;
  activeUnitId: string | null;
  activeSideId: string | null;
  /** Side whose player must act now (null once finished). */
  awaitingSideId: string | null;
  /** Options of the unit that waits (TeamPhase picking: the unit the AI would pick). */
  actionOptions: BattleActionOptions | null;
  /** TeamPhase picking: every ready unit of the awaiting side. */
  actorOptions: BattleActionOptions[] | null;
  turnOrder: TurnOrderPreview;
};

export type PvpBattleSessionInput = {
  state: BattleState;
  engine: BattleEngine;
  /** The two human sides (state team side ids). */
  sideIds: readonly [string, string];
  aiOptions?: BattleAiOptions;
};

export class PvpBattleSession {
  private state: BattleState;
  private readonly engine: BattleEngine;
  private readonly sideIds: readonly [string, string];
  private readonly aiOptions?: BattleAiOptions;
  private readonly commands: PvpCommandRecord[] = [];
  private readonly initialState: BattleState;
  private seq = 0;
  private last: PvpStepResult | null = null;

  constructor(input: PvpBattleSessionInput) {
    this.state = input.state;
    this.engine = input.engine;
    this.sideIds = input.sideIds;
    this.aiOptions = input.aiOptions;
    this.initialState = cloneBattleState(this.state);
  }

  get battleId(): string {
    return this.state.battleId;
  }

  get finished(): boolean {
    return this.state.phase === "finished";
  }

  /** Last step (null before `start`). */
  get lastResult(): PvpStepResult | null {
    return this.last;
  }

  /** Initial state + commands: replaying them reproduces the battle (seeded engine). */
  getReplay() {
    return { initialState: cloneBattleState(this.initialState), commands: structuredClone(this.commands) };
  }

  start(): PvpStepResult {
    const started = this.engine.start(this.state);
    if (!started.accepted) return this.finalize(started.events, false, started.error);
    this.state = started.state;
    return this.advance(started.events);
  }

  /** The side's player uses a skill (refused with `NOT_YOUR_TURN` when that side does not have to act). */
  useSkill(sideId: string, command: { actorId: string; skillId: string; targetId: string }): PvpStepResult {
    if (this.awaitingSide() !== sideId) return this.reject("NOT_YOUR_TURN");
    const actor = this.state.units[command.actorId];
    if (!actor || actor.sideId !== sideId) return this.reject("INVALID_PLAYER_ACTOR");

    const selectable = this.selectableActors(sideId);
    if (selectable.length > 0) return this.useSelectedActorSkill(sideId, command, selectable);

    const result = this.engine.dispatch(this.state, { type: "use_skill", ...command });
    if (!result.accepted) return this.finalize(result.events, false, result.error);
    this.commands.push({ sideId, type: "skill", ...command });
    this.state = result.state;
    return this.advance(result.events);
  }

  /** The AI plays the awaiting unit of `sideId` (auto button, turn timer, disconnected player). */
  auto(sideId: string): PvpStepResult {
    if (this.awaitingSide() !== sideId) return this.reject("NOT_YOUR_TURN");
    const events: BattleEvent[] = [];
    const selected = this.selectableActors(sideId)[0];
    if (selected) {
      const started = this.engine.dispatch(this.state, { type: "start_turn", actorId: selected.unitId });
      if (!started.accepted) return this.finalize(started.events, false, started.error);
      this.state = started.state;
      events.push(...started.events);
      if (this.state.phase !== "awaiting_action" || this.state.actingUnitId !== selected.unitId) {
        this.commands.push({ sideId, type: "auto" });
        return this.advance(events);
      }
    }

    const actorId = this.state.actingUnitId as string;
    const result = this.engine.dispatch(this.state, this.decide(actorId));
    events.push(...result.events);
    if (!result.accepted) return this.finalize(events, false, result.error);
    this.commands.push({ sideId, type: "auto" });
    this.state = result.state;
    return this.advance(events);
  }

  /** The side gives up at any time (also the opponent's turn). */
  surrender(sideId: string): PvpStepResult {
    if (this.finished) return this.reject("BATTLE_ALREADY_FINISHED");
    const result = this.engine.dispatch(this.state, { type: "surrender", sideId });
    if (!result.accepted) return this.finalize(result.events, false, result.error);
    this.commands.push({ sideId, type: "surrender" });
    this.state = result.state;
    return this.finalize(result.events, true, undefined);
  }

  /** Side whose player must act now (null once finished or while nothing waits). */
  awaitingSide(): string | null {
    if (this.state.phase === "finished") return null;
    for (const sideId of this.sideIds) if (this.selectableActors(sideId).length > 0) return sideId;
    if (this.state.phase !== "awaiting_action" || !this.state.actingUnitId) return null;
    const sideId = this.state.units[this.state.actingUnitId]?.sideId ?? null;
    return sideId && this.sideIds.includes(sideId) ? sideId : null;
  }

  // ── Internals (same flow as the PvE session, every side human) ─────

  private get turnOrder(): TurnOrderSystem {
    return getTurnOrderSystem(this.engine.getFormulas());
  }

  private useSelectedActorSkill(sideId: string, command: { actorId: string; skillId: string; targetId: string }, selectable: BattleUnitState[]): PvpStepResult {
    const actor = selectable.find((unit) => unit.unitId === command.actorId);
    if (!actor) return this.reject("ACTOR_NOT_READY");
    const skill = findUnitSkill(actor, command.skillId);
    if (!skill) return this.reject("UNKNOWN_SKILL");
    const failure = getSkillUsabilityFailure(this.state, actor, skill);
    if (failure) return this.reject(failure);
    const target = validateSkillTarget(this.state, actor, skill, command.targetId);
    if ("reason" in target) return this.reject(target.reason);

    const started = this.engine.dispatch(this.state, { type: "start_turn", actorId: actor.unitId });
    if (!started.accepted) return this.finalize(started.events, false, started.error);
    this.commands.push({ sideId, type: "skill", ...command });
    this.state = started.state;
    const events = [...started.events];
    if (this.state.phase !== "awaiting_action" || this.state.actingUnitId !== actor.unitId) return this.advance(events);

    const result = this.engine.dispatch(this.state, { type: "use_skill", ...command });
    events.push(...result.events);
    if (!result.accepted) return this.finalize(events, false, result.error);
    this.state = result.state;
    return this.advance(events);
  }

  /** Ready units of `sideId` its player may pick from (TeamPhase), when every one of them can act. */
  private selectableActors(sideId: string): BattleUnitState[] {
    const selectable = this.turnOrder.listSelectableActors(this.state, sideId);
    return selectable.every((unit) => this.canAct(unit)) ? selectable : [];
  }

  private canAct(unit: BattleUnitState): boolean {
    return !buildStatusSummary(unit).cannotAct && listUsableSkills(this.state, unit).length > 0;
  }

  private decide(actorId: string): BattleCommand {
    return decideAiCommand(this.state, actorId, this.engine.getFormulas(), this.aiOptions).command;
  }

  private turnOrderEvent(): BattleEvent[] {
    if (this.turnOrder.mode === "AttackBar") return [];
    const preview = this.turnOrder.preview(this.state, this.engine.getFormulas());
    return [{ type: "turn_order", battleId: this.state.battleId, round: preview.round, sideId: preview.sideId, actorIds: preview.actorIds, nextActorIds: preview.nextActorIds }];
  }

  private advance(seedEvents: BattleEvent[]): PvpStepResult {
    const events = [...seedEvents];
    let accepted = true;
    let error: string | undefined;

    for (let step = 0; step < MAX_AUTO_STEPS; step += 1) {
      if (this.state.phase === "finished") break;

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

        // TeamPhase: the side of the phase picks among its ready units that can act; blocked ones take their turn first.
        let picking = false;
        for (const sideId of this.sideIds) {
          const candidates = turnOrder.listSelectableActors(this.state, sideId);
          if (candidates.length === 0) continue;
          const blocked = candidates.find((unit) => !this.canAct(unit));
          if (!blocked) {
            picking = true;
            break;
          }
          nextActor = blocked;
          break;
        }
        events.push(...this.turnOrderEvent());
        if (picking) return this.finalize(events, accepted, error);

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
        if (this.sideIds.includes(actor.sideId)) return this.finalize(events, accepted, error);
        // A unit of neither side (never in the shipped content) is played by the AI.
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

    if (!error && this.state.phase !== "finished" && this.awaitingSide() === null) {
      error = "AUTO_ADVANCE_STALLED";
      accepted = false;
    }
    return this.finalize(events, accepted, error);
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

  /** A refused command changes nothing: the last step is answered again with the error (no new `seq`). */
  private reject(error: string): PvpStepResult {
    const base = this.last ?? this.finalize([], true, undefined, false);
    return { ...base, accepted: false, error, events: [] };
  }

  private finalize(events: BattleEvent[], accepted: boolean, error: string | undefined, record = true): PvpStepResult {
    const awaitingSideId = this.awaitingSide();
    let actionOptions: BattleActionOptions | null = null;
    let actorOptions: BattleActionOptions[] | null = null;
    if (awaitingSideId) {
      const selectable = this.selectableActors(awaitingSideId);
      if (selectable.length > 0) {
        actorOptions = selectable.map((unit) => this.buildActionOptions(unit));
        actionOptions = actorOptions[0];
      } else if (this.state.actingUnitId && this.state.units[this.state.actingUnitId]) {
        actionOptions = this.buildActionOptions(this.state.units[this.state.actingUnitId]);
      }
    }
    if (record && accepted) this.seq += 1;
    const finished = this.state.phase === "finished";
    const result: PvpStepResult = {
      accepted,
      seq: this.seq,
      state: this.state,
      events,
      phase: this.state.phase,
      turn: this.state.turn,
      round: this.state.round,
      finished,
      winnerSideId: this.state.winnerSideId,
      finishedReason: this.state.finishedReason,
      activeUnitId: this.state.actingUnitId,
      activeSideId: this.state.actingUnitId ? this.state.units[this.state.actingUnitId]?.sideId ?? null : null,
      awaitingSideId,
      actionOptions,
      actorOptions,
      turnOrder: this.turnOrder.preview(this.state, this.engine.getFormulas()),
    };
    if (error !== undefined) result.error = error;
    if (record) this.last = result;
    return result;
  }
}
