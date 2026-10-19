import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { Idempotency } from "../../shared/kernel/idempotency.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { noActivity, type PlayerActivitySink } from "../../shared/kernel/activity.js";
import { getStageCostFor } from "../../config/MapCatalog.js";
import type { EconomyService } from "../economy/economy.service.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { CharacterRepository } from "../roster/roster.ports.js";
import { ulid } from "ulid";
import type { PveBattleRepository } from "../battle-pve/battle-pve.ports.js";
import type { StageStartRequestDto, StageStartResponseDto } from "./map.dto.js";
import type { MapProgressRepository, MapRules, StageEntryGate, StageProgressRecord } from "./map.ports.js";
import { evaluateStageUnlock } from "./map.unlock.js";

/** Stage error with the `{ code, message }` shape the client expects from the map room. */
function stageError(code: string, message: string): AppError {
  return new AppError(code, { message });
}

export class MapService {
  constructor(
    private readonly progress: MapProgressRepository,
    private readonly maps: MapRules,
    private readonly characters: CharacterRepository,
    private readonly ledger: WalletLedger,
    private readonly economy: EconomyService,
    private readonly tickets: PveBattleRepository,
    private readonly uow: UnitOfWork,
    /** Optional extra entry rules (dungeon schedule / level gate). */
    private readonly gate?: StageEntryGate,
    /** Receives `energy_spent` after a paid stage start (missions). */
    private readonly activity: PlayerActivitySink = noActivity,
    /** Stored responses of repeated `requestId`s (`stage/validateStart`); default: no idempotency. */
    private readonly idempotency: Idempotency = new Idempotency(null, uow),
  ) {}

  /** Cleared stages (restores unlocks after login). */
  listProgress(userId: string): Promise<StageProgressRecord[]> {
    return this.progress.listProgress(userId);
  }

  /**
   * Validates a stage entry (unlocks, formation, ownership), pays its energy cost and issues the
   * ticket that `battle_start` consumes (stage clears/rewards are only granted by the battle room).
   */
  async validateStageStart(userId: string, req: StageStartRequestDto): Promise<StageStartResponseDto> {
    const repeated = await this.idempotency.replay<StageStartResponseDto>(userId, req.requestId, "stage_start");
    if (repeated) return repeated;

    const stage = this.maps.getStage(req.regionId, req.stageId);
    if (!stage) throw stageError("STAGE_NOT_FOUND", "Stage not found.");
    if (!stage.scene) throw stageError("STAGE_SCENE_MISSING", "Stage has no scene name.");

    const gated = this.gate ? await this.gate.check(userId, req.regionId, req.stageId) : null;
    if (gated) throw stageError(gated.code, gated.message);

    const unlock = evaluateStageUnlock(this.maps.catalog(), await this.progress.listProgress(userId), req.regionId, req.stageId, req.difficulty);
    if (unlock) throw stageError(unlock.code, unlock.message);

    const chosen = this.validateFormation(stage.formation, req.uidsInSlots, req.leaderSlotIndex);
    const owned = new Set((await this.characters.listByUids(userId, chosen)).map((record) => record.uid));
    if (chosen.some((uid) => !owned.has(uid))) throw stageError("UNIT_NOT_OWNED", "Invalid unit.");

    const currencyId = stage.currencyId;
    const cost = Math.max(0, getStageCostFor(stage, req.difficulty));

    const ticketId = ulid();
    let outcome: { value: StageStartResponseDto; replayed: boolean };
    try {
      outcome = await this.idempotency.run<StageStartResponseDto>(userId, req.requestId, "stage_start", async (session) => {
        if (cost > 0) await this.ledger.debit(session, userId, [{ currencyId, amount: cost }]);
        await this.progress.touchPrefs(userId, req.regionId, req.stageId, req.difficulty, session);
        await this.tickets.createTicket({
          id: ticketId,
          userId,
          regionId: req.regionId,
          stageId: req.stageId,
          difficulty: req.difficulty,
          currencyId,
          energySpent: cost,
        }, session);

        // The wallet is read inside the transaction: the stored response is the one the first call answered.
        const wallet: Record<string, number> = {};
        for (const row of await this.economy.getWallet(userId, session)) wallet[row.currencyId] = row.amount;
        return {
          ok: true as const,
          sceneName: stage.scene,
          currencyId,
          energySpent: cost,
          wallet,
          ticketId,
        };
      });
    } catch (error) {
      if (error instanceof AppError && error.errorCode === ErrorCode.ECON_INSUFFICIENT_FUNDS) {
        throw stageError("INSUFFICIENT_FUNDS", "Not enough energy.");
      }
      throw error;
    }

    if (!outcome.replayed && cost > 0) await this.activity.record(userId, "energy_spent", cost);
    return outcome.value;
  }

  private validateFormation(formation: { front: number; back: number } | undefined, uidsInSlots: string[], leaderSlotIndex: number): string[] {
    const maxSlots = Math.max(0, (formation?.front ?? 0) + (formation?.back ?? 0));
    const chosen = (Array.isArray(uidsInSlots) ? uidsInSlots : [])
      .map((uid) => String(uid || "").trim())
      .filter((uid) => uid.length > 0);

    if (maxSlots <= 0) throw stageError("INVALID_STAGE_FORMATION", "Stage formation is invalid.");
    if (chosen.length < 1) throw stageError("NO_UNITS", "Select at least 1 unit.");
    if (chosen.length > maxSlots) throw stageError("FORMATION_TOO_LARGE", "Too many units.");
    if (leaderSlotIndex < 0 || leaderSlotIndex >= maxSlots) throw stageError("INVALID_LEADER_SLOT", "Leader index out of range.");
    if (new Set(chosen).size !== chosen.length) throw stageError("DUPLICATE_UNITS", "Duplicate unit.");
    return chosen;
  }
}
