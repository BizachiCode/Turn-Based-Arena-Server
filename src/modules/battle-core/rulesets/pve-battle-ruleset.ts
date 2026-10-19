import { BaseBattleRuleset, resolveTurnLimitDraw } from "./base-battle-ruleset";
import { isSideDefeated, readMetadataNumber } from "../domain/battle-state-utils";
import type { BattleState } from "../domain/battle-state";
import type { BattleResolutionResult } from "./battle-ruleset";

/**
 * PvE: the player side loses when wiped; the enemy side loses when wiped and no wave is pending
 * (`metadata.pendingEnemyWaveCount`). Optional `metadata.turnLimit` ends the battle as a draw.
 */
export class PveBattleRuleset extends BaseBattleRuleset {
  readonly id = "pve-default";
  readonly mode = "pve" as const;

  resolveBattle(state: BattleState): BattleResolutionResult {
    const playerSideId = typeof state.metadata?.playerSideId === "string"
      ? state.metadata.playerSideId
      : state.teams.find((team) => team.isPlayerControlled)?.sideId ?? state.teams[0]?.sideId ?? null;

    const enemySideId = typeof state.metadata?.enemySideId === "string"
      ? state.metadata.enemySideId
      : state.teams.find((team) => team.sideId !== playerSideId)?.sideId ?? null;

    const pendingEnemyWaveCount = Math.max(0, Math.floor(readMetadataNumber(state.metadata, "pendingEnemyWaveCount") ?? 0));
    if (!playerSideId || !enemySideId) return super.resolveBattle(state);

    if (isSideDefeated(state, playerSideId)) {
      return {
        finished: true,
        winnerSideId: enemySideId,
        reason: "elimination",
      };
    }

    if (isSideDefeated(state, enemySideId)) {
      if (pendingEnemyWaveCount > 0) return { finished: false };

      return {
        finished: true,
        winnerSideId: playerSideId,
        reason: "elimination",
      };
    }

    return resolveTurnLimitDraw(state);
  }
}
