import {
  createServerBattleEngine,
  PveBattleRuleset,
  PveBattleSession,
  type PveBattleSessionInput,
  type PveBattleSessionStepResult,
} from "../battle-core";

/** Step result returned by every session method (start, usePlayerSkill, usePlayerAuto, surrender). */
export type BattlePveSessionStepResult = PveBattleSessionStepResult;

export type BattlePveSessionInput = PveBattleSessionInput;

/**
 * Server PvE session: the battle-core {@link PveBattleSession} wired to the server engine
 * (combat config catalog, rune set and passive runtime systems). The battle seed is read from
 * `state.metadata.seed` (defaults to the battle id).
 */
export class BattlePveSession extends PveBattleSession {
  constructor(input: BattlePveSessionInput) {
    super({
      ...input,
      engine: input.engine ?? createServerBattleEngine(new PveBattleRuleset()),
    });
  }
}
