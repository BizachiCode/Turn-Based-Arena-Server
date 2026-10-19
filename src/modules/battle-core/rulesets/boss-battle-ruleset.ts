import { listAliveUnitsBySide } from "../domain/battle-state-utils";
import type { BattleState } from "../domain/battle-state";
import type { BattleResolutionResult } from "./battle-ruleset";
import { BaseBattleRuleset } from "./base-battle-ruleset";

export class BossBattleRuleset extends BaseBattleRuleset {
  readonly id = "boss-default";
  readonly mode = "boss" as const;

  override resolveBattle(state: BattleState): BattleResolutionResult {
    const bossSideId = typeof state.metadata.bossSideId === "string"
      ? state.metadata.bossSideId
      : state.teams.find((team) => team.sideId.toLowerCase().includes("boss"))?.sideId ?? state.teams[1]?.sideId ?? null;

    const challengerSideId = typeof state.metadata.challengerSideId === "string"
      ? state.metadata.challengerSideId
      : state.teams.find((team) => team.sideId !== bossSideId)?.sideId ?? state.teams[0]?.sideId ?? null;

    if (!bossSideId || !challengerSideId) {
      return super.resolveBattle(state);
    }

    const bossAlive = listAliveUnitsBySide(state, bossSideId).length > 0;
    const challengersAlive = listAliveUnitsBySide(state, challengerSideId).length > 0;

    if (!bossAlive && challengersAlive) {
      return { finished: true, winnerSideId: challengerSideId, reason: "elimination" };
    }

    if (!challengersAlive && bossAlive) {
      return { finished: true, winnerSideId: bossSideId, reason: "elimination" };
    }

    const turnLimit = typeof state.metadata.turnLimit === "number" && Number.isFinite(state.metadata.turnLimit)
      ? state.metadata.turnLimit
      : null;

    const turnAlreadyResolved = state.phase !== "awaiting_action" && state.phase !== "resolving_action";
    if (turnLimit && turnAlreadyResolved && state.turn >= turnLimit) {
      return {
        finished: true,
        winnerSideId: bossAlive ? bossSideId : challengerSideId,
        reason: "turn_limit",
      };
    }

    return { finished: false };
  }
}
