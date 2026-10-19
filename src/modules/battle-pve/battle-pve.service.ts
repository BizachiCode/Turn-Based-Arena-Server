// PvE battle use cases: ticket-checked battle start and result settlement.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { StageDifficulty } from "../../shared/kernel/types.js";
import { BattlePveSessionError, type BattlePveSessionFactory } from "./BattlePveSessionFactory.js";
import type { BattlePveSessionStepResult } from "./BattlePveSession.js";
import type { PveBattleRepository } from "./battle-pve.ports.js";
import { BattleSessionAdapter } from "./battle-session.adapter.js";
import type { BattleResultDto, BattleRewardService } from "./battle-rewards.service.js";

export type StartBattleInput = {
  regionId: string;
  stageId: string;
  difficulty: StageDifficulty;
  uidsInSlots: string[];
  leaderSlotIndex: number;
  requestId: string;
  /** Ticket returned by `stage/validateStart` (optional: newest matching ticket otherwise). */
  ticketId?: string | null;
};

export class BattlePveService {
  constructor(
    private readonly sessions: BattlePveSessionFactory,
    private readonly battles: PveBattleRepository,
    private readonly rewards: BattleRewardService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    /** Minutes a paid stage ticket stays usable (read on every start: config imports apply at once). */
    private readonly ticketTtlMinutes: () => number,
  ) {}

  /**
   * Builds the battle from the player's own units and consumes the paid ticket created by
   * `stage/validateStart` (energy is never charged twice, battles can't start for free).
   */
  async startBattle(userId: string, input: StartBattleInput): Promise<BattleSessionAdapter> {
    const notBefore = new Date(this.clock.nowMs() - this.ticketTtlMinutes() * 60_000);
    const noTicket = () => new AppError(ErrorCode.STAGE_NOT_VALIDATED, { message: "Call stage/validateStart before battle_start." });
    // Cheap pre-check: a player without a ticket must not make the server build sessions (DB reads + engine setup).
    if (!(await this.battles.hasUsableTicket(userId, input, notBefore, input.ticketId ?? null))) throw noTicket();

    let adapter: BattleSessionAdapter;
    try {
      adapter = new BattleSessionAdapter(await this.sessions.create({ userId, ...input }));
    } catch (error) {
      if (error instanceof BattlePveSessionError) throw new AppError(error.code, { message: error.message });
      throw error;
    }

    const ticket = await this.uow.transaction((session) =>
      this.battles.consumeTicket(userId, input, adapter.battleId, notBefore, input.ticketId ?? null, session),
    );
    if (!ticket) throw noTicket();

    return adapter;
  }

  /**
   * Settles a finished step (idempotent per battle): rewards only when the session reports `victory`.
   * Returns null while the battle is still running.
   */
  async settleIfFinished(userId: string, battleId: string, step: BattlePveSessionStepResult): Promise<BattleResultDto | null> {
    if (!step.finished) return null;

    const playerSideId = String(step.state.metadata?.playerSideId ?? "players");
    const unitUids = Object.values(step.state.units)
      .filter((unit) => unit.sideId === playerSideId)
      .map((unit) => String((unit.metadata as Record<string, unknown> | undefined)?.rosterUid ?? ""))
      .filter((uid) => uid.length > 0);

    return this.rewards.settle(userId, {
      battleId,
      victory: step.victory === true,
      unitUids,
      clearMs: null,
    });
  }

}
