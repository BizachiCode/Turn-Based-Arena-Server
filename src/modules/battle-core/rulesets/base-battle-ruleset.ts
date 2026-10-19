import type { BattleCommand } from "../domain/battle-command";
import { isSideDefeated, readMetadataNumber } from "../domain/battle-state-utils";
import type { BattleMode, BattleState, BattleUnitState } from "../domain/battle-state";
import type { BattleEvent } from "../domain/battle-event";
import type { BattleResolutionResult, BattleRuleset, BattleValidationResult } from "./battle-ruleset";

/**
 * Turn limit check shared by rulesets: when `state.metadata.turnLimit` (> 0) is reached after a turn has been
 * fully resolved, the battle ends as a draw (winner null, reason `turn_limit`).
 */
export function resolveTurnLimitDraw(state: BattleState): BattleResolutionResult {
  const turnLimit = readMetadataNumber(state.metadata, "turnLimit");
  const turnResolved = state.phase !== "awaiting_action" && state.phase !== "resolving_action";
  if (turnLimit && turnLimit > 0 && turnResolved && state.turn >= turnLimit) {
    return { finished: true, winnerSideId: null, reason: "turn_limit" };
  }
  return { finished: false };
}

export abstract class BaseBattleRuleset implements BattleRuleset {
  abstract readonly id: string;
  abstract readonly mode: BattleMode;

  validateCommand(_state: BattleState, _command: BattleCommand): BattleValidationResult {
    return { ok: true };
  }

  onBattleStarted(_state: BattleState): BattleEvent[] {
    return [];
  }

  onTurnStarted(_state: BattleState, _actor: BattleUnitState): BattleEvent[] {
    return [];
  }

  onTurnEnded(_state: BattleState, _actor: BattleUnitState): BattleEvent[] {
    return [];
  }

  resolveBattle(state: BattleState): BattleResolutionResult {
    const aliveTeams = state.teams.filter((team) => !isSideDefeated(state, team.sideId));

    if (aliveTeams.length > 1) return resolveTurnLimitDraw(state);
    if (aliveTeams.length === 1) {
      return {
        finished: true,
        winnerSideId: aliveTeams[0].sideId,
        reason: "elimination",
      };
    }

    return {
      finished: true,
      winnerSideId: null,
      reason: "draw",
    };
  }
}
