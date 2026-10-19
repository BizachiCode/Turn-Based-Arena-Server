import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { StageDifficulty } from "../../shared/kernel/types.js";
import type { BattlePveSessionStepResult } from "./BattlePveSession.js";

export type PveBattleStatus = "TICKET" | "STARTED" | "VICTORY" | "DEFEAT" | "EXPIRED";

/** One paid stage entry (`pve_battles`). */
export type PveBattleRecord = {
  id: string;
  userId: string;
  regionId: string;
  stageId: string;
  difficulty: StageDifficulty;
  status: PveBattleStatus;
  battleId: string | null;
  startedAt: Date | null;
  result: unknown;
  /** Energy paid for the ticket (drives the account EXP of a won stage). */
  energySpent?: number;
};

export type NewStageTicket = {
  id: string;
  userId: string;
  regionId: string;
  stageId: string;
  difficulty: StageDifficulty;
  currencyId: string;
  energySpent: number;
};

/** Persistence port for stage tickets and battle outcomes. */
export interface PveBattleRepository {
  createTicket(ticket: NewStageTicket, session: DbSession): Promise<void>;
  /**
   * Locks the newest unused ticket of the user for this stage (optionally a specific `ticketId`)
   * created after `notBefore`, and binds it to `battleId` (status STARTED).
   */
  consumeTicket(
    userId: string,
    stage: { regionId: string; stageId: string; difficulty: StageDifficulty },
    battleId: string,
    notBefore: Date,
    ticketId: string | null,
    session: DbSession,
  ): Promise<PveBattleRecord | null>;
  /**
   * Cheap non-locking check (no transaction): does the user have an unused, unexpired ticket for this stage
   * (optionally a specific `ticketId`)? Lets `battle_start` reject ticketless callers before building a session;
   * the authoritative consume stays `consumeTicket`.
   */
  hasUsableTicket(
    userId: string,
    stage: { regionId: string; stageId: string; difficulty: StageDifficulty },
    notBefore: Date,
    ticketId: string | null,
  ): Promise<boolean>;
  lockByBattleId(userId: string, battleId: string, session: DbSession): Promise<PveBattleRecord | null>;
  finish(id: string, status: "VICTORY" | "DEFEAT", result: unknown, session: DbSession): Promise<void>;
}

/**
 * Player intent the battle session understands (input only — the server resolves everything, skill levels
 * come from the player's roster).
 */
export type PlayerSkillCommand = {
  actorId: string;
  skillId: string;
  targetId: string;
};

/** What the battle room needs from a battle session (implemented by `BattlePveSession`). */
export interface BattleSessionPort {
  readonly battleId: string;
  start(): BattlePveSessionStepResult;
  usePlayerSkill(command: PlayerSkillCommand): BattlePveSessionStepResult;
  /** Plays the current player unit's turn with the AI. */
  usePlayerAuto(): BattlePveSessionStepResult;
  /** Ends the battle as a defeat. */
  surrender(): BattlePveSessionStepResult;
}
