import type { BattleCommand } from "../domain/battle-command";
import type { BattleEvent, BattleFinishReason } from "../domain/battle-event";
import type { BattleMode, BattleState, BattleUnitState } from "../domain/battle-state";

export type BattleValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export type BattleResolutionResult =
  | { finished: false }
  | { finished: true; winnerSideId: string | null; reason: BattleFinishReason };

export interface BattleRuleset {
  readonly id: string;
  readonly mode: BattleMode;

  validateCommand(state: BattleState, command: BattleCommand): BattleValidationResult;
  onBattleStarted?(state: BattleState): BattleEvent[];
  onTurnStarted?(state: BattleState, actor: BattleUnitState): BattleEvent[];
  onTurnEnded?(state: BattleState, actor: BattleUnitState): BattleEvent[];
  resolveBattle(state: BattleState): BattleResolutionResult;
}
