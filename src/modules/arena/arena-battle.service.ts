// Arena battles: start (spends one Arena Wing in the transaction that creates the battle) and settlement
// (Elo for the attacker and a real defender + rewards, exactly once per battle id).

import { noActivity, type PlayerActivitySink } from "../../shared/kernel/activity.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { CurrencyAmount, WalletSnapshot } from "../../shared/kernel/types.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { ArenaConfig, ArenaNpcRival } from "../../config/ArenaCatalog.js";
import { BattleSessionAdapter } from "../battle-pve/battle-session.adapter.js";
import { mergeAmounts } from "../economy/economy.domain.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import { ARENA_WING_CURRENCY, parseOpponentId } from "./arena.domain.js";
import type { ArenaRepository } from "./arena.ports.js";
import { asAppError } from "./arena.service.js";
import type { ArenaSessionFactory } from "./arena-session.factory.js";
import { resolveArenaRatings } from "./arena-rating.js";
import type { ArenaSeasonService } from "./arena-season.service.js";

export type StartArenaBattleInput = {
  opponentId: string;
  uidsInSlots: string[];
  leaderSlotIndex: number;
  requestId?: string | null;
};

/** `result` attached to the final frame of an arena battle. */
export type ArenaResultDto = {
  victory: boolean;
  currencies: CurrencyAmount[];
  arena: { ratingBefore: number; ratingAfter: number; delta: number };
  wallet: WalletSnapshot;
};

export type ArenaBattleServiceDeps = {
  arena: ArenaRepository;
  sessions: ArenaSessionFactory;
  ledger: WalletLedger;
  uow: UnitOfWork;
  clock: Clock;
  audit: AuditLog;
  config: () => ArenaConfig;
  /** Receives `arena_battle` once per settled battle (guild quests). */
  activity?: PlayerActivitySink;
  /** Seasons: ended seasons of both players are settled before the rating changes; attacks are counted per season. */
  seasons?: ArenaSeasonService | null;
};

export class ArenaBattleService {
  constructor(private readonly deps: ArenaBattleServiceDeps) {}

  /**
   * Starts an attack on an offered opponent: builds both teams, then — in one transaction — spends the wing,
   * records the battle and consumes the opponent list. Wings are not refunded on defeat.
   */
  async startBattle(userId: string, input: StartArenaBattleInput): Promise<BattleSessionAdapter> {
    const { arena, uow, ledger } = this.deps;
    const cfg = this.deps.config();

    const parsed = parseOpponentId(input.opponentId);
    const profile = await arena.ensureProfile(userId, cfg.startRating);
    if (!parsed || !profile.opponents?.some((offered) => offered.opponentId === input.opponentId)) {
      throw new AppError(ErrorCode.OPPONENT_NOT_OFFERED);
    }

    let defenderUserId: string | null = null;
    let npc: ArenaNpcRival | null = null;
    let defense;
    if (parsed.kind === "npc") {
      npc = cfg.npcRivals.find((entry) => entry.id === parsed.npcId) ?? null;
      if (!npc) throw new AppError(ErrorCode.OPPONENT_NOT_OFFERED);
    } else {
      const defender = await arena.findProfileByPublicId(parsed.publicId);
      if (!defender || defender.userId === userId) throw new AppError(ErrorCode.OPPONENT_NOT_OFFERED);
      if (!defender.defense) throw new AppError(ErrorCode.NO_DEFENSE);
      defenderUserId = defender.userId;
      defense = defender.defense;
    }

    let session;
    try {
      session = await this.deps.sessions.create({
        attacker: { userId, uidsInSlots: input.uidsInSlots, leaderSlotIndex: input.leaderSlotIndex },
        defender: npc ? { kind: "npc", npc } : { kind: "player", userId: defenderUserId!, defense: defense! },
        opponentId: input.opponentId,
        turnLimit: cfg.turnLimit,
        requestId: input.requestId,
      });
    } catch (error) {
      throw asAppError(error);
    }

    await uow.transaction(async (tx) => {
      const locked = await arena.ensureProfile(userId, cfg.startRating, tx, true);
      if (!locked.opponents?.some((offered) => offered.opponentId === input.opponentId)) {
        throw new AppError(ErrorCode.OPPONENT_NOT_OFFERED);
      }

      const wingCost = this.deps.config().wingCost;
      if (wingCost > 0) {
        await ledger.debit(tx, userId, [{ currencyId: ARENA_WING_CURRENCY, amount: wingCost }], { insufficientError: ErrorCode.NOT_ENOUGH_CURRENCY });
      }
      await arena.insertBattle({
        battleId: session.battleId,
        attackerId: userId,
        defenderId: defenderUserId,
        npcId: npc?.id ?? null,
        attackerRatingBefore: locked.rating,
      }, tx);
      await arena.saveOpponents(userId, null, undefined, tx);
    });

    return new BattleSessionAdapter(session, "arena");
  }

  /**
   * Settles a finished battle (victory, defeat, surrender, turn limit, abandoned): rating changes and rewards are
   * applied once; a second call returns the stored result.
   */
  async settle(userId: string, battleId: string, victory: boolean): Promise<ArenaResultDto> {
    const { arena, uow, ledger, clock } = this.deps;
    const cfg = this.deps.config();

    let settledNow = false;
    const mailed: string[] = [];
    const settled = await uow.transaction(async (tx) => {
      // The unit of work re-runs this callback after a deadlock: start every attempt clean.
      settledNow = false;
      mailed.length = 0;
      const battle = await arena.lockBattle(battleId, userId, tx);
      if (!battle) throw new AppError(ErrorCode.BATTLE_NOT_STARTED);
      if (battle.rewardsGranted) return battle.result as ArenaResultDto;

      const profiles = await arena.lockProfiles([userId, ...(battle.defenderId ? [battle.defenderId] : [])], tx);
      let attacker = profiles.get(userId) ?? await arena.ensureProfile(userId, cfg.startRating, tx, true);
      let defender = battle.defenderId ? profiles.get(battle.defenderId) ?? null : null;
      const seasons = this.deps.seasons;
      if (seasons) {
        // Ended seasons are settled with the ratings they ended with, before this battle moves them.
        const rolled = await seasons.rolloverLocked(tx, attacker);
        attacker = rolled.profile;
        if (rolled.mailed) mailed.push(attacker.userId);
        if (defender) {
          const rolledDefender = await seasons.rolloverLocked(tx, defender);
          defender = rolledDefender.profile;
          if (rolledDefender.mailed) mailed.push(defender.userId);
        }
      }
      const npcRating = cfg.npcRivals.find((entry) => entry.id === battle.npcId)?.rating ?? cfg.startRating;

      const ratings = resolveArenaRatings({
        attackerRating: attacker.rating,
        defenderRating: defender?.rating ?? npcRating,
        attackerWon: victory,
        kFactor: cfg.kFactor,
        defenderIsNpc: !defender,
      });

      const granted = mergeAmounts(victory ? cfg.rewards.win : cfg.rewards.loss);
      const currencies = [...granted].map(([currencyId, amount]) => ({ currencyId, amount }));
      await ledger.credit(tx, userId, currencies);

      await arena.applyBattleResult(userId, {
        rating: ratings.attackerAfter,
        winsDelta: victory ? 1 : 0,
        lossesDelta: victory ? 0 : 1,
        seasonBattlesDelta: 1,
      }, tx);
      if (defender) {
        await arena.applyBattleResult(defender.userId, {
          rating: ratings.defenderAfter,
          defenseWinsDelta: victory ? 0 : 1,
          defenseLossesDelta: victory ? 1 : 0,
        }, tx);
      }

      const result: ArenaResultDto = {
        victory,
        currencies,
        arena: { ratingBefore: attacker.rating, ratingAfter: ratings.attackerAfter, delta: ratings.attackerDelta },
        wallet: await ledger.snapshot(userId, tx),
      };
      await arena.finishBattle(battleId, {
        won: victory,
        attackerRatingBefore: attacker.rating,
        ratingDelta: ratings.attackerDelta,
        defenderDelta: defender ? ratings.defenderDelta : 0,
        result,
        at: new Date(clock.nowMs()),
      }, tx);
      await this.deps.audit.record({
        userId,
        kind: "ARENA_REWARD",
        meta: { battleId, victory, delta: ratings.attackerDelta, currencies, defenderId: battle.defenderId, npcId: battle.npcId },
      }, tx);
      settledNow = true;
      return result;
    });
    if (settledNow) await (this.deps.activity ?? noActivity).record(userId, "arena_battle");
    if (mailed.length > 0) await this.deps.seasons?.notify(mailed);
    return settled;
  }
}
