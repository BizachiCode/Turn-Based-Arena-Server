import type { BattleCommand } from "../domain/battle-command";
import type { BattleState } from "../domain/battle-state";
import type { BattleValidationResult } from "./battle-ruleset";
import { BaseBattleRuleset } from "./base-battle-ruleset";

export class ArenaBattleRuleset extends BaseBattleRuleset {
  readonly id = "arena-default";
  readonly mode = "arena" as const;

  override validateCommand(state: BattleState, command: BattleCommand): BattleValidationResult {
    if (command.type === "surrender") {
      const hasSide = state.teams.some((team) => team.sideId === command.sideId);
      if (!hasSide) return { ok: false, reason: "UNKNOWN_SIDE" };
    }

    return { ok: true };
  }
}
