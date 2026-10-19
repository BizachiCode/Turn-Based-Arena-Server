// What each player of a PvP battle receives: the step seen from their side. Their own team is the
// `isPlayerControlled` one (`localSideId`), the opponent's unit identities (roster / rune uids) are stripped, and the
// action options only reach the player who must act.

import type { BattleState } from "../battle-core/index.js";
import type { PvpStepResult } from "./pvp-battle-session.js";

/** Opponent unit metadata never sent to the other player. */
const PRIVATE_UNIT_METADATA = ["rosterUid", "equippedRuneUids"];

export function perspectiveState(state: BattleState, viewerSideId: string): BattleState {
  const view = structuredClone(state);
  const otherSideId = view.teams.find((team) => team.sideId !== viewerSideId)?.sideId ?? null;
  for (const team of view.teams) team.isPlayerControlled = team.sideId === viewerSideId;
  for (const unit of Object.values(view.units)) {
    if (unit.sideId === viewerSideId || !unit.metadata) continue;
    for (const key of PRIVATE_UNIT_METADATA) delete (unit.metadata as Record<string, unknown>)[key];
  }
  const leaderOf = (sideId: string | null) => (view.teams.find((team) => team.sideId === sideId)?.metadata as { leaderSkillId?: unknown } | undefined)?.leaderSkillId ?? null;
  view.metadata = {
    ...view.metadata,
    playerSideId: viewerSideId,
    enemySideId: otherSideId,
    playerLeaderSkillId: leaderOf(viewerSideId),
    enemyWaveLeaderSkillIds: [leaderOf(otherSideId)],
  };
  return view;
}

export type PvpFrameExtras = {
  matchId: string;
  /** When the awaiting player's turn timer runs out (null while nobody must act). */
  turnDeadlineUnix: number | null;
};

/** Battle frame of one player (same fields as the PvE frame plus `localSideId`, `awaitingSideId`, `seq`). */
export function buildPvpFrame(step: PvpStepResult, viewerSideId: string, extras: PvpFrameExtras) {
  const mine = step.awaitingSideId === viewerSideId;
  return {
    battleId: step.state.battleId,
    matchId: extras.matchId,
    seq: step.seq,
    localSideId: viewerSideId,
    phase: step.phase,
    turn: step.turn,
    round: step.round,
    finished: step.finished,
    victory: step.finished ? step.winnerSideId === viewerSideId : null,
    winnerSideId: step.winnerSideId,
    finishedReason: step.finishedReason,
    awaitingPlayerInput: mine,
    awaitingSideId: step.awaitingSideId,
    activeUnitId: step.activeUnitId,
    activeSideId: step.activeSideId,
    currentWaveIndex: 0,
    totalWaves: 1,
    actionOptions: mine ? step.actionOptions : null,
    actorOptions: mine ? step.actorOptions : null,
    turnOrder: step.turnOrder,
    turnDeadlineUnix: extras.turnDeadlineUnix,
    state: perspectiveState(step.state, viewerSideId),
    events: step.events,
  };
}
