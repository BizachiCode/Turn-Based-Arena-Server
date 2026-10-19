import type { BattleEvent, BattleFinishReason } from "./battle-event";
import type { BattleState, BattleTeamState, BattleUnitState } from "./battle-state";
import { normalizeBattleLine, type BattleLine } from "../types/battle-data";

/**
 * Deterministic ordinal string comparison (UTF-16 code units), identical to C# `string.CompareOrdinal`.
 * Used everywhere ids are sorted so the TypeScript and C# engines order units identically.
 */
export function compareOrdinal(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function cloneBattleState(state: BattleState): BattleState {
  return structuredClone(state);
}

export function getBattleUnit(state: BattleState, unitId: string): BattleUnitState | undefined {
  if (typeof unitId !== "string" || !Object.prototype.hasOwnProperty.call(state.units, unitId)) return undefined;
  return state.units[unitId];
}

/**
 * Every unit in canonical order: teams in `state.teams` order, units in `team.unitIds` order, followed by any
 * unit that is not referenced by a team (in insertion order). The C# engine uses the same order.
 */
export function listBattleUnits(state: BattleState): BattleUnitState[] {
  const out: BattleUnitState[] = [];
  const seen = new Set<string>();

  for (const team of state.teams) {
    for (const unitId of team.unitIds) {
      if (seen.has(unitId)) continue;
      const unit = getBattleUnit(state, unitId);
      if (!unit) continue;
      seen.add(unitId);
      out.push(unit);
    }
  }

  for (const unitId of Object.keys(state.units)) {
    if (seen.has(unitId)) continue;
    seen.add(unitId);
    out.push(state.units[unitId]);
  }

  return out;
}

export function listUnitsBySide(state: BattleState, sideId: string): BattleUnitState[] {
  return listBattleUnits(state).filter((unit) => unit.sideId === sideId);
}

export function listAliveUnitsBySide(state: BattleState, sideId: string): BattleUnitState[] {
  return listUnitsBySide(state, sideId).filter((unit) => unit.currentHp > 0);
}

export function listDeadUnitsBySide(state: BattleState, sideId: string): BattleUnitState[] {
  return listUnitsBySide(state, sideId).filter((unit) => unit.currentHp <= 0);
}

/** Alive units on every side other than `sideId`, in canonical order. */
export function listAliveEnemyUnits(state: BattleState, sideId: string): BattleUnitState[] {
  return listBattleUnits(state).filter((unit) => unit.sideId !== sideId && unit.currentHp > 0);
}

export function isSideDefeated(state: BattleState, sideId: string): boolean {
  return listAliveUnitsBySide(state, sideId).length === 0;
}

export function getEnemySideIds(state: BattleState, sideId: string): string[] {
  return state.teams.filter((team) => team.sideId !== sideId).map((team) => team.sideId);
}

export function getFirstAliveEnemySideId(state: BattleState, sideId: string): string | null {
  for (const enemySideId of getEnemySideIds(state, sideId)) {
    if (!isSideDefeated(state, enemySideId)) return enemySideId;
  }

  return null;
}

/** Formation line of a unit: `unit.line`, else `metadata.row` / `metadata.line`; null when unknown. */
export function getUnitLine(unit: BattleUnitState): BattleLine | null {
  const direct = normalizeBattleLine(unit.line);
  if (direct) return direct;
  return normalizeBattleLine(unit.metadata?.row) ?? normalizeBattleLine(unit.metadata?.line);
}

export function setBattlePhase(state: BattleState, phase: BattleState["phase"], events: BattleEvent[]): void {
  if (state.phase === phase) return;
  state.phase = phase;
  events.push({
    type: "phase_changed",
    battleId: state.battleId,
    phase,
  });
}

export function finishBattle(
  state: BattleState,
  winnerSideId: string | null,
  reason: BattleFinishReason,
  events: BattleEvent[]
): void {
  if (state.phase === "finished") return;

  state.winnerSideId = winnerSideId;
  state.finishedReason = reason;
  state.actingUnitId = null;
  setBattlePhase(state, "finished", events);
  events.push({
    type: "battle_finished",
    battleId: state.battleId,
    winnerSideId,
    reason,
    turn: state.turn,
  });
}

export function getTeam(state: BattleState, sideId: string): BattleTeamState | undefined {
  return state.teams.find((team) => team.sideId === sideId);
}

/** Reads a finite number from `state.metadata` (null when missing). */
export function readMetadataNumber(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  const raw = metadata?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Reads a non-empty string from `state.metadata` (null when missing). */
export function readMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const raw = metadata?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
