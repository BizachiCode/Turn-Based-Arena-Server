// Battle settlement: records the clear and grants stage rewards exactly once per battle,
// in a single transaction (currencies, first-clear bonus, drop table + extra drops, unit EXP, account EXP, rune drop
// with weighted stars and grade).

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { noActivity, type PlayerActivitySink } from "../../shared/kernel/activity.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { RandomSource } from "../../shared/kernel/random.js";
import type { CurrencyAmount, StageDifficulty, WalletSnapshot } from "../../shared/kernel/types.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { getStageRewardFor } from "../../config/MapCatalog.js";
import { rollStageDrops } from "./stage-drops.js";
import { mergeAmounts } from "../economy/economy.domain.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { MapProgressRepository, MapRules } from "../map/map.ports.js";
import type { AccountProgressDto, AccountProgressionService } from "../progression/account-progression.service.js";
import type { SeasonalClearRecorder } from "../tower/tower.ports.js";
import type { MonsterProgression } from "../progression/progression.rules.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { CharacterRepository } from "../roster/roster.ports.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { RuneSyncDto } from "../rune/rune.dto.js";
import type { RuneService } from "../rune/rune.service.js";
import type { PveBattleRepository } from "./battle-pve.ports.js";

export type UnitRewardDto = {
  uid: string;
  characterId: string;
  expGained: number;
  level: number;
  currentExp: number;
  leveledUp: boolean;
};

/** `result` attached to the final battle frame. */
export type BattleResultDto =
  | { victory: false }
  | {
      victory: true;
      firstClear: boolean;
      currencies: CurrencyAmount[];
      units: UnitRewardDto[];
      runes: RuneSyncDto[];
      /** Account EXP/level after the victory (absent when account progression is disabled). */
      account?: AccountProgressDto;
      wallet: WalletSnapshot;
    };

export type BattleOutcome = {
  battleId: string;
  victory: boolean;
  /** Roster uids of the player's units that took part (alive or dead). */
  unitUids: string[];
  clearMs: number | null;
};

export class BattleRewardService {
  constructor(
    private readonly battles: PveBattleRepository,
    private readonly progress: MapProgressRepository,
    private readonly maps: MapRules,
    private readonly ledger: WalletLedger,
    private readonly characters: CharacterRepository,
    private readonly progression: MonsterProgression,
    private readonly runes: RuneService,
    private readonly rosterCache: RosterCache,
    private readonly runeCache: RuneCache,
    private readonly random: RandomSource,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    /** Receives `stage_clear` after a newly settled victory (guild quests). */
    private readonly activity: PlayerActivitySink = noActivity,
    /** Grants account EXP for victories (level-up rewards and energy refill). */
    private readonly account?: AccountProgressionService,
    /** Towers: the first-clear rewards come back every season. */
    private readonly seasonal?: SeasonalClearRecorder,
  ) {}

  /** Settles a finished battle. Idempotent: a second call returns the stored result. */
  async settle(userId: string, outcome: BattleOutcome): Promise<BattleResultDto> {
    let settledNow = false;
    let regionId = "";
    let towerFloorCleared = false;
    const result = await this.uow.transaction(async (session) => {
      // The callback may re-run after a deadlock retry: reset what a previous attempt could have set.
      settledNow = false;
      towerFloorCleared = false;
      const battle = await this.battles.lockByBattleId(userId, outcome.battleId, session);
      if (!battle) throw new AppError(ErrorCode.BATTLE_NOT_STARTED);
      regionId = battle.regionId;
      if (battle.status === "VICTORY" || battle.status === "DEFEAT") return battle.result as BattleResultDto;

      if (!outcome.victory) {
        const defeat: BattleResultDto = { victory: false };
        await this.battles.finish(battle.id, "DEFEAT", defeat, session);
        return defeat;
      }

      const stage = this.maps.getStage(battle.regionId, battle.stageId);
      const reward = stage ? getStageRewardFor(stage, battle.difficulty) : undefined;
      const clearMs = outcome.clearMs ?? (battle.startedAt ? Math.max(0, this.clock.nowMs() - battle.startedAt.getTime()) : null);

      const clear = await this.progress.recordClear(userId, battle.regionId, battle.stageId, battle.difficulty as StageDifficulty, clearMs, session);
      const season = this.seasonal ? await this.seasonal.recordClear(session, userId, battle.regionId, battle.stageId) : null;
      if (season?.applies) {
        clear.firstClear = season.firstThisSeason;
        towerFloorCleared = season.firstThisSeason;
      }

      const drops = reward ? rollStageDrops(this.random, reward.dropTable, reward.randomDrops) : { currencies: [], rune: null };
      const granted = mergeAmounts([
        ...(reward?.currencies ?? []),
        ...(clear.firstClear ? reward?.firstClearCurrencies ?? [] : []),
        ...drops.currencies,
      ]);
      const currencies = [...granted].map(([currencyId, amount]) => ({ currencyId, amount }));

      // Lock order: characters first, wallet second (same as power-up / summon / sell / evolve), to avoid deadlocks.
      const units = await this.grantUnitExp(userId, outcome.unitUids, reward?.unitExp ?? 0, session);
      await this.ledger.credit(session, userId, currencies);

      let runes: RuneSyncDto[] = [];
      if (drops.rune) {
        const { tier, quality, setId } = drops.rune;
        runes = await this.runes.grantRunes(session, userId, [{ tier, quality, setId, origin: "stage_drop" }], { whenFull: "skip" });
      }

      const accountExp = this.account?.expForStage(reward?.accountExp ?? 0, battle.energySpent ?? 0) ?? 0;
      const account = this.account ? await this.account.grant(session, userId, accountExp) : null;

      const victory: BattleResultDto = {
        victory: true,
        firstClear: clear.firstClear,
        currencies,
        units,
        runes,
        ...(account ? { account } : {}),
        wallet: await this.ledger.snapshot(userId, session),
      };
      await this.battles.finish(battle.id, "VICTORY", victory, session);
      settledNow = true;
      await this.audit.record({
        userId,
        kind: "STAGE_REWARD",
        meta: { battleId: outcome.battleId, regionId: battle.regionId, stageId: battle.stageId, difficulty: battle.difficulty, currencies, runes: runes.length, accountExp: account?.expGained ?? 0 },
      }, session);
      return victory;
    });

    if (result.victory) {
      await this.rosterCache.invalidate(userId);
      if (result.runes.length > 0) await this.runeCache.invalidate(userId);
    }
    if (settledNow && result.victory) {
      await this.activity.record(userId, "stage_clear");
      if (this.maps.catalog().regions.find((region) => region.id === regionId)?.kind === "dungeon") await this.activity.record(userId, "dungeon_clear");
      if (towerFloorCleared) await this.activity.record(userId, "tower_clear");
      if (result.account && result.account.levelsGained > 0) await this.activity.record(userId, "account_level", result.account.level);
    }
    return result;
  }

  private async grantUnitExp(userId: string, unitUids: string[], unitExp: number, session: DbSession): Promise<UnitRewardDto[]> {
    const uids = [...new Set(unitUids.filter((uid) => !!uid))];
    if (uids.length === 0) return [];

    const records = await this.characters.lockByUids(userId, uids, session);
    const units: UnitRewardDto[] = [];
    for (const record of records) {
      const levelUp = this.progression.applyExp(record.stars, record.level, record.currentExp, unitExp);
      if (levelUp.expConsumed > 0 || levelUp.finalLevel !== record.level || levelUp.finalExp !== record.currentExp) {
        await this.characters.updateProgress(userId, record.uid, levelUp.finalLevel, levelUp.finalExp, session);
      }
      units.push({
        uid: record.uid,
        characterId: record.characterId,
        expGained: levelUp.expConsumed,
        level: levelUp.finalLevel,
        currentExp: levelUp.finalExp,
        leveledUp: levelUp.levelsGained > 0,
      });
    }
    return units;
  }
}
