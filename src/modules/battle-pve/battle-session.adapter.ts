// Wraps a battle session for the room: forwards every intent to the session and remembers the last step
// (used by `battle_result` and to know whether the battle is still running).

import type { BattlePveSessionStepResult } from "./BattlePveSession.js";
import type { BattleSessionPort, PlayerSkillCommand } from "./battle-pve.ports.js";

export class BattleSessionAdapter {
  private last: BattlePveSessionStepResult | null = null;

  constructor(
    private readonly session: BattleSessionPort,
    /** `arena` sessions settle through the arena service (rating + arena rewards) instead of stage rewards. */
    readonly mode: "pve" | "arena" = "pve",
  ) {}

  get battleId(): string {
    return this.session.battleId;
  }

  /** Last step result (null before start). */
  get lastResult(): BattlePveSessionStepResult | null {
    return this.last;
  }

  /** True once the last step reported the end of the battle. */
  get finished(): boolean {
    return this.last?.finished === true;
  }

  start(): BattlePveSessionStepResult {
    return this.remember(this.session.start());
  }

  usePlayerSkill(command: PlayerSkillCommand): BattlePveSessionStepResult {
    return this.remember(this.session.usePlayerSkill(command));
  }

  usePlayerAuto(): BattlePveSessionStepResult {
    return this.remember(this.session.usePlayerAuto());
  }

  surrender(): BattlePveSessionStepResult {
    return this.remember(this.session.surrender());
  }

  private remember(result: BattlePveSessionStepResult): BattlePveSessionStepResult {
    this.last = result;
    return result;
  }
}
