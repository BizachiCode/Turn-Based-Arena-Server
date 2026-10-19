import type { BattleEvent } from "../domain/battle-event";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import { compareOrdinal, getBattleUnit, listBattleUnits, readMetadataString } from "../domain/battle-state-utils";
import {
  createDefaultCombatFormulaSnapshot,
  resolveCombatFormula,
  type CombatFormulaSnapshot,
  type ResolvedCombatFormula,
  type TurnOrderMode,
} from "../domain/combat-formula";
import { getEffectiveStat } from "../effects/combat-effect-math";
import { boostTurnBar, changeTurnBar } from "../statuses/status-engine";

const EPSILON = 0.0001;

/** Metadata key of the unit that was granted an extra turn and must act next. */
export const EXTRA_TURN_METADATA_KEY = "extraTurnActorId";

/**
 * Metadata key of an ExtraTurn effect that succeeded during the current turn (`{ actorId, source, skillId |
 * passiveId }`); the engine grants it when the turn ends.
 */
export const PENDING_EXTRA_TURN_METADATA_KEY = "pendingExtraTurn";

/**
 * Metadata key of the round state of the round modes (`{ round, sideId, leadSideId, pending }`). AttackBar never
 * writes it.
 */
export const TURN_ORDER_METADATA_KEY = "turnOrder";


/** Upcoming actors as the client shows them (turn-order strip). */
export type TurnOrderPreview = {
  mode: TurnOrderMode;
  round: number;
  /** AlternatingSides: side of the next slot; TeamPhase: side of the current phase; otherwise null. */
  sideId: string | null;
  /** Actions left in the current round (TeamPhase: phase) in order; AttackBar: the next actors. */
  actorIds: string[];
  /** Predicted order of the next round (TeamPhase: the units of the next phase); empty for AttackBar. */
  nextActorIds: string[];
};

/**
 * Turn order strategy: the engine and the PvE session ask it who acts next, how time advances and how turn bars
 * behave. Implementations are stateless; everything they track lives in the battle state (turn bars,
 * `metadata.extraTurnActorId`, `metadata.turnOrder`), so battles replay identically in TypeScript and C#.
 */
export interface TurnOrderSystem {
  readonly mode: TurnOrderMode;
  /** Whether the unit may start a turn now (`start_turn` validation). */
  isReady(state: BattleState, unit: BattleUnitState): boolean;
  /** Ready units in acting order. */
  listReadyActors(state: BattleState): BattleUnitState[];
  /** Next actor: the extra-turn unit first, otherwise the first ready unit; null when time must advance. */
  selectNextActor(state: BattleState): BattleUnitState | null;
  /** Advances time (attack bar fill, new round / phase). Returns no event when nothing can advance. */
  advance(state: BattleState, formulas: ResolvedCombatFormula): BattleEvent[];
  /** Turn start bookkeeping (the attack bar is consumed, round queues updated). */
  onTurnStarted(state: BattleState, actor: BattleUnitState, extraTurn: boolean): BattleEvent[];
  /** Round number reported by `turn_started` and `state.round` (after the turn counter was incremented). */
  resolveRound(state: BattleState): number;
  /** Attack bar cap of a unit. */
  maxTurnBar(unit: BattleUnitState, formulas: ResolvedCombatFormula): number;
  /** Applies an attack bar change; `fromEffect` increases are blocked by Freeze. */
  applyTurnBarChange(unit: BattleUnitState, delta: number, formulas: ResolvedCombatFormula, fromEffect: boolean): BattleEvent[];
  /** Grants an extra turn: the unit acts right after the current turn. Returns the attack bar events. */
  grantExtraTurn(state: BattleState, actor: BattleUnitState, formulas: ResolvedCombatFormula): BattleEvent[];
  /** A dead unit came back (Revive effect). */
  onUnitRevived(state: BattleState, unit: BattleUnitState, formulas: ResolvedCombatFormula): BattleEvent[];
  /** A new enemy wave spawned (the session already reset the turn bars). */
  onWaveStarted(state: BattleState): void;
  /** Upcoming actors. */
  preview(state: BattleState, formulas: ResolvedCombatFormula): TurnOrderPreview;
  /**
   * Units of `sideId` the player may choose from before the next turn starts (TeamPhase manual play), in the AI
   * order; empty when the next actor is not the player's choice.
   */
  listSelectableActors(state: BattleState, sideId: string): BattleUnitState[];
}

export function roundTurnBar(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Effective speed including SpeedUp / Slow (percentage of the base speed). */
export function getEffectiveBattleSpeed(unit: BattleUnitState): number {
  return getEffectiveStat(unit, "spd");
}

/** Attack bar desc, effective speed desc, ordinal unit id. */
function compareByTurnBar(a: BattleUnitState, b: BattleUnitState): number {
  if (Math.abs(b.turnBar - a.turnBar) > EPSILON) return b.turnBar - a.turnBar;
  return compareBySpeed(a, b);
}

/** Effective speed desc, ordinal unit id. */
function compareBySpeed(a: BattleUnitState, b: BattleUnitState): number {
  const speedDiff = getEffectiveBattleSpeed(b) - getEffectiveBattleSpeed(a);
  if (Math.abs(speedDiff) > EPSILON) return speedDiff;
  return compareOrdinal(a.unitId, b.unitId);
}

function hasFullBar(unit: BattleUnitState): boolean {
  return unit.turnBar + EPSILON >= unit.turnThreshold;
}

function aliveUnits(state: BattleState): BattleUnitState[] {
  return listBattleUnits(state).filter((unit) => unit.currentHp > 0);
}

function extraTurnActor(state: BattleState, ready: (unit: BattleUnitState) => boolean): BattleUnitState | null {
  const extraTurnId = readMetadataString(state.metadata, EXTRA_TURN_METADATA_KEY);
  if (!extraTurnId) return null;
  const unit = getBattleUnit(state, extraTurnId);
  return unit && ready(unit) ? unit : null;
}

function setTurnBar(unit: BattleUnitState, value: number, events: BattleEvent[]): void {
  const previous = unit.turnBar;
  if (Math.abs(value - previous) <= EPSILON) return;
  unit.turnBar = value;
  events.push({ type: "turn_bar_changed", targetId: unit.unitId, amount: roundTurnBar(value - previous), currentTurnBar: value });
}

/** Behaviour shared by every mode (attack bar consumption, changes, extra turns). */
abstract class TurnOrderSystemBase implements TurnOrderSystem {
  abstract readonly mode: TurnOrderMode;
  abstract isReady(state: BattleState, unit: BattleUnitState): boolean;
  abstract listReadyActors(state: BattleState): BattleUnitState[];
  abstract advance(state: BattleState, formulas: ResolvedCombatFormula): BattleEvent[];
  abstract resolveRound(state: BattleState): number;
  abstract preview(state: BattleState, formulas: ResolvedCombatFormula): TurnOrderPreview;

  selectNextActor(state: BattleState): BattleUnitState | null {
    return extraTurnActor(state, (unit) => this.isReady(state, unit)) ?? this.listReadyActors(state)[0] ?? null;
  }

  onTurnStarted(_state: BattleState, actor: BattleUnitState, _extraTurn: boolean): BattleEvent[] {
    const consumed = actor.turnBar;
    actor.turnBar = 0;
    return consumed !== 0 ? [{ type: "turn_bar_changed", targetId: actor.unitId, amount: -consumed, currentTurnBar: 0 }] : [];
  }

  maxTurnBar(unit: BattleUnitState, formulas: ResolvedCombatFormula): number {
    return unit.turnThreshold * formulas.turnOrder.roundModeTurnBarCap;
  }

  applyTurnBarChange(unit: BattleUnitState, delta: number, formulas: ResolvedCombatFormula, fromEffect: boolean): BattleEvent[] {
    const cap = this.maxTurnBar(unit, formulas);
    return (fromEffect ? boostTurnBar(unit, delta, cap) : changeTurnBar(unit, delta, cap)).events;
  }

  grantExtraTurn(state: BattleState, actor: BattleUnitState, formulas: ResolvedCombatFormula): BattleEvent[] {
    state.metadata[EXTRA_TURN_METADATA_KEY] = actor.unitId;
    return this.applyTurnBarChange(actor, Math.max(0, actor.turnThreshold - actor.turnBar), formulas, false);
  }

  onUnitRevived(_state: BattleState, _unit: BattleUnitState, _formulas: ResolvedCombatFormula): BattleEvent[] {
    return [];
  }

  onWaveStarted(_state: BattleState): void {}

  listSelectableActors(_state: BattleState, _sideId: string): BattleUnitState[] {
    return [];
  }
}

/* ------------------------------------------------------------------ AttackBar */

/** Attack bar: every living unit fills `effectiveSpeed * t`; ready at 100%. */
export class AttackBarTurnOrder extends TurnOrderSystemBase {
  readonly mode = "AttackBar" as const;

  isReady(_state: BattleState, unit: BattleUnitState): boolean {
    return unit.currentHp > 0 && unit.turnBar >= unit.turnThreshold;
  }

  listReadyActors(state: BattleState): BattleUnitState[] {
    return aliveUnits(state).filter(hasFullBar).sort(compareByTurnBar);
  }

  selectNextActor(state: BattleState): BattleUnitState | null {
    return extraTurnActor(state, (unit) => unit.currentHp > 0 && hasFullBar(unit)) ?? this.listReadyActors(state)[0] ?? null;
  }

  maxTurnBar(unit: BattleUnitState, formulas: ResolvedCombatFormula): number {
    return unit.turnThreshold * formulas.timing.turnBarHeadroomMultiplier;
  }

  resolveRound(state: BattleState): number {
    return Math.max(1, Math.ceil(state.turn / Math.max(1, listBattleUnits(state).length)));
  }

  /**
   * Advances every living unit's turn bar by `speed * t` where `t` is the smallest time for one unit to reach its
   * threshold. Turn bars are rounded to 3 decimals and capped at `threshold * turnBarHeadroomMultiplier`.
   */
  advance(state: BattleState, formulas: ResolvedCombatFormula): BattleEvent[] {
    if (this.listReadyActors(state).length > 0) return [];
    const bars = new Map<string, number>(aliveUnits(state).map((unit) => [unit.unitId, unit.turnBar]));
    if (!fillBars(aliveUnits(state), bars, formulas)) return [];

    const events: BattleEvent[] = [];
    for (const unit of aliveUnits(state)) {
      const next = bars.get(unit.unitId) as number;
      const previous = unit.turnBar;
      if (Math.abs(next - previous) <= EPSILON) continue;
      unit.turnBar = next;
      events.push({ type: "turn_bar_changed", targetId: unit.unitId, amount: roundTurnBar(next - previous), currentTurnBar: next });
    }
    return events;
  }

  /** Simulates the attack bar (no state change): the next actors, one per living unit. */
  preview(state: BattleState, formulas: ResolvedCombatFormula): TurnOrderPreview {
    const alive = aliveUnits(state);
    const bars = new Map<string, number>(alive.map((unit) => [unit.unitId, unit.turnBar]));
    const order: string[] = [];
    const extra = extraTurnActor(state, (unit) => unit.currentHp > 0 && hasFullBar(unit));
    if (extra) {
      order.push(extra.unitId);
      bars.set(extra.unitId, 0);
    }

    for (let guard = 0; order.length < alive.length && guard < alive.length * 20; guard++) {
      const ready = alive
        .filter((unit) => (bars.get(unit.unitId) as number) + EPSILON >= unit.turnThreshold)
        .sort((a, b) => {
          const diff = (bars.get(b.unitId) as number) - (bars.get(a.unitId) as number);
          return Math.abs(diff) > EPSILON ? diff : compareBySpeed(a, b);
        });
      if (ready.length > 0) {
        order.push(ready[0].unitId);
        bars.set(ready[0].unitId, 0);
        continue;
      }
      if (!fillBars(alive, bars, formulas)) break;
    }

    return { mode: this.mode, round: state.round, sideId: null, actorIds: order, nextActorIds: [] };
  }
}

/** One ATB fill step on `bars` (the time for the closest unit to reach its threshold). False when no unit moves. */
function fillBars(units: BattleUnitState[], bars: Map<string, number>, formulas: ResolvedCombatFormula): boolean {
  if (units.length === 0) return false;
  let timeStep = Number.POSITIVE_INFINITY;
  for (const unit of units) {
    const speed = getEffectiveBattleSpeed(unit);
    if (speed <= EPSILON) continue;
    timeStep = Math.min(timeStep, Math.max(0, unit.turnThreshold - (bars.get(unit.unitId) as number)) / speed);
  }
  // Rounding can leave a unit 0.001 short of its threshold: any positive step is valid.
  if (!Number.isFinite(timeStep) || timeStep <= 0) return false;

  let moved = false;
  for (const unit of units) {
    const speed = getEffectiveBattleSpeed(unit);
    if (speed <= EPSILON) continue;
    const previous = bars.get(unit.unitId) as number;
    const maxTurnBar = unit.turnThreshold * formulas.timing.turnBarHeadroomMultiplier;
    const next = roundTurnBar(Math.min(maxTurnBar, previous + (speed * timeStep)));
    if (Math.abs(next - previous) <= EPSILON) continue;
    bars.set(unit.unitId, next);
    moved = true;
  }
  return moved;
}

/* ------------------------------------------------------------------ round modes */

/** Round state of the round modes (`metadata.turnOrder`). */
export type TurnOrderRoundState = {
  round: number;
  /** AlternatingSides: side of the next slot; TeamPhase: side of the current phase. */
  sideId: string | null;
  /** TeamPhase: side that opens every round. */
  leadSideId: string | null;
  /** SpeedRounds / AlternatingSides: units that still have their action of this round. */
  pending: string[];
};

export function readRoundState(state: BattleState): TurnOrderRoundState {
  const raw = state.metadata?.[TURN_ORDER_METADATA_KEY];
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    round: typeof source.round === "number" && Number.isFinite(source.round) ? source.round : 0,
    sideId: typeof source.sideId === "string" ? source.sideId : null,
    leadSideId: typeof source.leadSideId === "string" ? source.leadSideId : null,
    pending: Array.isArray(source.pending) ? source.pending.filter((id): id is string => typeof id === "string") : [],
  };
}

function writeRoundState(state: BattleState, round: TurnOrderRoundState): void {
  state.metadata[TURN_ORDER_METADATA_KEY] = {
    round: round.round,
    sideId: round.sideId,
    leadSideId: round.leadSideId,
    pending: [...round.pending],
  };
}

/** Side after `sideId` in `state.teams` order (cyclic) that still has a living unit; null when none. */
function nextSideId(state: BattleState, sideId: string | null): string | null {
  const teams = state.teams;
  if (teams.length === 0) return null;
  const index = teams.findIndex((team) => team.sideId === sideId);
  for (let step = 1; step <= teams.length; step++) {
    const team = teams[(index + step + teams.length) % teams.length];
    if (aliveUnits(state).some((unit) => unit.sideId === team.sideId)) return team.sideId;
  }
  return null;
}

/**
 * Round position bars: the k-th of n units (by speed) gets `threshold * (1 + (n - 1 - k) / n)` on top of the bar it
 * kept from the previous round, so an attack bar change of `f` moves it about `f * n` places.
 */
function assignRoundBars(group: BattleUnitState[], formulas: ResolvedCombatFormula, system: TurnOrderSystem, events: BattleEvent[]): void {
  const n = group.length;
  group.forEach((unit, k) => {
    const position = unit.turnThreshold * (1 + ((n - 1 - k) / n));
    setTurnBar(unit, roundTurnBar(Math.min(system.maxTurnBar(unit, formulas), unit.turnBar + position)), events);
  });
}

/** Shared logic of SpeedRounds and AlternatingSides: one regular action per unit and round. */
abstract class QueuedRoundTurnOrder extends TurnOrderSystemBase {
  isReady(state: BattleState, unit: BattleUnitState): boolean {
    if (unit.currentHp <= 0) return false;
    return hasFullBar(unit) || readRoundState(state).pending.includes(unit.unitId);
  }

  listReadyActors(state: BattleState): BattleUnitState[] {
    return aliveUnits(state).filter((unit) => this.isReady(state, unit)).sort(compareByTurnBar);
  }

  resolveRound(state: BattleState): number {
    return Math.max(1, readRoundState(state).round);
  }

  onTurnStarted(state: BattleState, actor: BattleUnitState, extraTurn: boolean): BattleEvent[] {
    const events = super.onTurnStarted(state, actor, extraTurn);
    const round = readRoundState(state);
    round.pending = round.pending.filter((id) => id !== actor.unitId);
    if (!extraTurn) round.sideId = this.sideAfterTurn(state, actor);
    writeRoundState(state, round);
    return events;
  }

  /** Units revived during a round act from the next round on. */
  onUnitRevived(state: BattleState, unit: BattleUnitState): BattleEvent[] {
    const round = readRoundState(state);
    if (!round.pending.includes(unit.unitId)) return [];
    round.pending = round.pending.filter((id) => id !== unit.unitId);
    writeRoundState(state, round);
    return [];
  }

  /** A new wave starts a new round. */
  onWaveStarted(state: BattleState): void {
    const round = readRoundState(state);
    writeRoundState(state, { ...round, sideId: null, pending: [] });
  }

  advance(state: BattleState, formulas: ResolvedCombatFormula): BattleEvent[] {
    if (this.listReadyActors(state).length > 0) return [];
    const alive = aliveUnits(state);
    if (alive.length === 0) return [];

    const round = readRoundState(state);
    round.round += 1;
    const events: BattleEvent[] = [{ type: "round_started", battleId: state.battleId, round: round.round }];
    const bySpeed = [...alive].sort(compareBySpeed);
    for (const group of this.rankGroups(state, bySpeed)) assignRoundBars(group, formulas, this, events);
    round.pending = bySpeed.map((unit) => unit.unitId);
    round.sideId = this.firstSideOfRound(bySpeed);
    writeRoundState(state, round);
    return events;
  }

  /** Units ranked together for the round position bars. */
  protected abstract rankGroups(state: BattleState, bySpeed: BattleUnitState[]): BattleUnitState[][];
  protected abstract firstSideOfRound(bySpeed: BattleUnitState[]): string | null;
  protected abstract sideAfterTurn(state: BattleState, actor: BattleUnitState): string | null;
}

/** Every living unit acts once per round, fastest first (speed changes count from the next round). */
export class SpeedRoundsTurnOrder extends QueuedRoundTurnOrder {
  readonly mode = "SpeedRounds" as const;

  protected rankGroups(_state: BattleState, bySpeed: BattleUnitState[]): BattleUnitState[][] {
    return [bySpeed];
  }

  protected firstSideOfRound(): string | null {
    return null;
  }

  protected sideAfterTurn(): string | null {
    return null;
  }

  preview(state: BattleState): TurnOrderPreview {
    const actorIds: string[] = [];
    const extra = extraTurnActor(state, (unit) => this.isReady(state, unit));
    if (extra) actorIds.push(extra.unitId);
    for (const unit of this.listReadyActors(state)) if (unit !== extra) actorIds.push(unit.unitId);
    return {
      mode: this.mode,
      round: this.resolveRound(state),
      sideId: null,
      actorIds,
      nextActorIds: [...aliveUnits(state)].sort(compareBySpeed).map((unit) => unit.unitId),
    };
  }
}

/** The sides alternate; each side's next actor is its best placed unit that has not acted this round. */
export class AlternatingSidesTurnOrder extends QueuedRoundTurnOrder {
  readonly mode = "AlternatingSides" as const;

  protected rankGroups(state: BattleState, bySpeed: BattleUnitState[]): BattleUnitState[][] {
    return state.teams
      .map((team) => bySpeed.filter((unit) => unit.sideId === team.sideId))
      .filter((group) => group.length > 0);
  }

  protected firstSideOfRound(bySpeed: BattleUnitState[]): string | null {
    return bySpeed[0]?.sideId ?? null;
  }

  protected sideAfterTurn(state: BattleState, actor: BattleUnitState): string | null {
    return nextSideId(state, actor.sideId);
  }

  /** The ready units of the slot's side first; when that side has none, the next side with a ready unit. */
  listReadyActors(state: BattleState): BattleUnitState[] {
    const ready = aliveUnits(state).filter((unit) => this.isReady(state, unit)).sort(compareByTurnBar);
    const slot = readRoundState(state).sideId;
    const sides = orderedSidesFrom(state, slot);
    return sides.flatMap((sideId) => ready.filter((unit) => unit.sideId === sideId));
  }

  preview(state: BattleState): TurnOrderPreview {
    const round = readRoundState(state);
    const extra = extraTurnActor(state, (unit) => this.isReady(state, unit));
    const actorIds = simulateAlternation(
      state,
      aliveUnits(state).filter((unit) => this.isReady(state, unit)),
      (unit) => unit.turnBar,
      round.sideId,
      extra
    );
    const bySpeed = [...aliveUnits(state)].sort(compareBySpeed);
    const nextActorIds = simulateAlternation(state, bySpeed, (unit) => -bySpeed.indexOf(unit), bySpeed[0]?.sideId ?? null, null);
    return { mode: this.mode, round: this.resolveRound(state), sideId: round.sideId, actorIds, nextActorIds };
  }
}

/** Sides in `state.teams` order starting at `first` (all sides when `first` is unknown). */
function orderedSidesFrom(state: BattleState, first: string | null): string[] {
  const ids = state.teams.map((team) => team.sideId);
  const start = Math.max(0, ids.indexOf(first ?? ""));
  return ids.map((_, i) => ids[(start + i) % ids.length]);
}

/** Alternation of `candidates` (each acts once) starting with `firstSide`; `score` orders a side's units (desc). */
function simulateAlternation(
  state: BattleState,
  candidates: BattleUnitState[],
  score: (unit: BattleUnitState) => number,
  firstSide: string | null,
  extra: BattleUnitState | null
): string[] {
  const order: string[] = [];
  const left = candidates.filter((unit) => unit !== extra);
  if (extra) order.push(extra.unitId);
  let side = firstSide;
  while (left.length > 0) {
    let picked: BattleUnitState | null = null;
    for (const sideId of orderedSidesFrom(state, side)) {
      const ofSide = left.filter((unit) => unit.sideId === sideId).sort((a, b) => {
        const diff = score(b) - score(a);
        return Math.abs(diff) > EPSILON ? diff : compareBySpeed(a, b);
      });
      if (ofSide.length > 0) {
        picked = ofSide[0];
        break;
      }
    }
    if (!picked) break;
    order.push(picked.unitId);
    left.splice(left.indexOf(picked), 1);
    const ids = state.teams.map((team) => team.sideId);
    side = ids.length > 0 ? ids[(ids.indexOf(picked.sideId) + 1) % ids.length] : null;
  }
  return order;
}

/**
 * A whole side acts (the player picks the order; the AI goes fastest first), then the next side. Every unit of a
 * side is charged to `100% + teamPhaseSkipThreshold` for its phase; a unit acts while its bar is at least 100%.
 */
export class TeamPhaseTurnOrder extends TurnOrderSystemBase {
  readonly mode = "TeamPhase" as const;

  isReady(state: BattleState, unit: BattleUnitState): boolean {
    return unit.currentHp > 0 && unit.sideId === readRoundState(state).sideId && hasFullBar(unit);
  }

  listReadyActors(state: BattleState): BattleUnitState[] {
    return aliveUnits(state).filter((unit) => this.isReady(state, unit)).sort(compareBySpeed);
  }

  resolveRound(state: BattleState): number {
    return Math.max(1, readRoundState(state).round);
  }

  private charge(unit: BattleUnitState, formulas: ResolvedCombatFormula, events: BattleEvent[]): void {
    const amount = unit.turnThreshold * (1 + formulas.turnOrder.teamPhaseSkipThreshold);
    setTurnBar(unit, roundTurnBar(Math.min(this.maxTurnBar(unit, formulas), unit.turnBar + amount)), events);
  }

  /**
   * Opens the first phase (battle start, new wave: every unit charged, the side of the fastest unit leads) or ends
   * the current phase (its side is charged for its next phase) and opens the next side's phase.
   */
  advance(state: BattleState, formulas: ResolvedCombatFormula): BattleEvent[] {
    if (this.listReadyActors(state).length > 0) return [];
    const alive = aliveUnits(state);
    if (alive.length === 0) return [];

    const round = readRoundState(state);
    const events: BattleEvent[] = [];
    if (!round.sideId) {
      const lead = [...alive].sort(compareBySpeed)[0].sideId;
      round.round += 1;
      round.sideId = lead;
      round.leadSideId = lead;
      events.push({ type: "round_started", battleId: state.battleId, round: round.round });
      for (const unit of alive) this.charge(unit, formulas, events);
    } else {
      for (const unit of alive) if (unit.sideId === round.sideId) this.charge(unit, formulas, events);
      const next = nextSideId(state, round.sideId) ?? round.sideId;
      if (!alive.some((unit) => unit.sideId === round.leadSideId)) round.leadSideId = next;
      if (next === round.leadSideId) {
        round.round += 1;
        events.push({ type: "round_started", battleId: state.battleId, round: round.round });
      }
      round.sideId = next;
    }
    round.pending = [];
    writeRoundState(state, round);
    events.push({ type: "team_phase_started", battleId: state.battleId, sideId: round.sideId as string, round: round.round });
    return events;
  }

  /** A unit revived outside its side's phase is charged for that phase; during it, it waits for the next one. */
  onUnitRevived(state: BattleState, unit: BattleUnitState, formulas: ResolvedCombatFormula): BattleEvent[] {
    const round = readRoundState(state);
    if (!round.sideId || unit.sideId === round.sideId) return [];
    const events: BattleEvent[] = [];
    this.charge(unit, formulas, events);
    return events;
  }

  /** A new wave restarts the phases (every unit charged again, the fastest side leads). */
  onWaveStarted(state: BattleState): void {
    const round = readRoundState(state);
    writeRoundState(state, { ...round, sideId: null, leadSideId: null, pending: [] });
  }

  listSelectableActors(state: BattleState, sideId: string): BattleUnitState[] {
    if (state.phase !== "waiting_for_turn") return [];
    if (readRoundState(state).sideId !== sideId) return [];
    if (extraTurnActor(state, (unit) => this.isReady(state, unit))) return [];
    return this.listReadyActors(state).filter((unit) => unit.sideId === sideId);
  }

  preview(state: BattleState): TurnOrderPreview {
    const round = readRoundState(state);
    const extra = extraTurnActor(state, (unit) => this.isReady(state, unit));
    const actorIds = extra ? [extra.unitId] : [];
    for (const unit of this.listReadyActors(state)) if (unit !== extra) actorIds.push(unit.unitId);
    const next = round.sideId ? nextSideId(state, round.sideId) : null;
    const nextActorIds = next
      ? aliveUnits(state).filter((unit) => unit.sideId === next).sort(compareBySpeed).map((unit) => unit.unitId)
      : [];
    return { mode: this.mode, round: this.resolveRound(state), sideId: round.sideId, actorIds, nextActorIds };
  }
}

const SYSTEMS: Record<TurnOrderMode, TurnOrderSystem> = {
  AttackBar: new AttackBarTurnOrder(),
  SpeedRounds: new SpeedRoundsTurnOrder(),
  AlternatingSides: new AlternatingSidesTurnOrder(),
  TeamPhase: new TeamPhaseTurnOrder(),
};

/** Turn order system configured by the combat formula (`turnOrder.mode`, default AttackBar). */
export function getTurnOrderSystem(
  formulas: CombatFormulaSnapshot | ResolvedCombatFormula | null | undefined = createDefaultCombatFormulaSnapshot()
): TurnOrderSystem {
  return SYSTEMS[resolveCombatFormula(formulas).turnOrder.mode] ?? SYSTEMS.AttackBar;
}

/** Attack bar cap of a unit under the configured turn order system. */
export function getMaxTurnBar(unit: BattleUnitState, formulas: ResolvedCombatFormula): number {
  return getTurnOrderSystem(formulas).maxTurnBar(unit, formulas);
}
