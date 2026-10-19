import { noActivity, type PlayerActivitySink } from "../../shared/kernel/activity.js";
import { AppError } from "../../shared/errors/app-error.js";
import { pickWeighted, type RandomSource } from "../../shared/kernel/random.js";
import { Idempotency } from "../../shared/kernel/idempotency.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { systemClock, type Clock } from "../../shared/kernel/clock.js";
import { isSummonScrollAvailable } from "../../config/SummonCatalog.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { CharacterGrantService, CharacterRules } from "../roster/character-grant.service.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { SummonGrantDto, SummonResultDto, SummonTarget } from "./summon.dto.js";
import { resolveSummonEconomy } from "./summon.economy.js";
import type { SummonCounterRepository, SummonCurrencyLookup, SummonRules } from "./summon.ports.js";

/** Summon error codes (sent verbatim to the client). */
export const SummonError = {
  INVALID_REQUEST: "INVALID_REQUEST",
  ROSTER_FULL: "ROSTER_FULL",
  NOT_ENOUGH_SCROLLS: "NOT_ENOUGH_SCROLLS",
  SCROLL_NOT_FOUND: "SCROLL_NOT_FOUND",
  /** Banner-style scroll outside its `availableFromUnix..availableUntilUnix` window. */
  SCROLL_NOT_AVAILABLE: "SCROLL_NOT_AVAILABLE",
  EMPTY_POOL: "EMPTY_POOL",
  CHAR_NOT_IN_CATALOG: "CHAR_NOT_IN_CATALOG",
  INVALID_WEIGHT_LIST: "INVALID_WEIGHT_LIST",
} as const;

export type SummonRequest = {
  scrollId: string;
  /** 1 = single summon, 10 = multi summon (grants `multiGive`). */
  multi: boolean;
  target: SummonTarget;
  /** Client idempotency key: a repeated id returns the first response without summoning again. */
  requestId?: string;
};

export class SummonService {
  constructor(
    private readonly scrolls: SummonRules,
    private readonly currencies: SummonCurrencyLookup,
    private readonly characterRules: CharacterRules,
    private readonly characterGrants: CharacterGrantService,
    private readonly ledger: WalletLedger,
    private readonly rosterCache: RosterCache,
    private readonly random: RandomSource,
    private readonly uow: UnitOfWork,
    /** Receives `summon` (one per monster summoned) for the guild quests. */
    private readonly activity: PlayerActivitySink = noActivity,
    /** Server time for banner windows. */
    private readonly clock: Clock = systemClock,
    /** Summons per scroll, for the tutorial guaranteed summons (none without it). */
    private readonly counters: SummonCounterRepository | null = null,
    /** Stored responses of repeated `requestId`s (default: no idempotency). */
    private readonly idempotency: Idempotency = new Idempotency(null, uow),
  ) {}

  async summon(userId: string, request: SummonRequest): Promise<SummonResultDto> {
    const repeated = await this.idempotency.replay<SummonResultDto>(userId, request.requestId, "summon");
    if (repeated) return repeated;

    const scroll = this.scrolls.get(request.scrollId);
    if (!scroll) throw new AppError(SummonError.SCROLL_NOT_FOUND);
    if (!isSummonScrollAvailable(scroll, this.clock.nowMs())) throw new AppError(SummonError.SCROLL_NOT_AVAILABLE);

    const economy = resolveSummonEconomy(request.scrollId, scroll, this.currencies);
    if (request.multi && !economy.multiEnabled) throw new AppError(SummonError.INVALID_REQUEST);
    const give = request.multi ? economy.multiGive : 1;
    const cost = request.multi ? economy.costTenPlusOne : economy.costSingle;
    const rolls = Array.from({ length: give }, () => this.roll(request.scrollId));

    const { value: result, replayed } = await this.idempotency.run<SummonResultDto>(userId, request.requestId, "summon", async (session) => {
      const free = await this.characterGrants.freeSlots(session, userId, request.target);
      if (free < give) throw new AppError(SummonError.ROSTER_FULL, { fields: { target: request.target } });

      const walletAfter = await this.ledger.debit(session, userId, [{ currencyId: economy.currencyId, amount: cost }], {
        insufficientError: SummonError.NOT_ENOUGH_SCROLLS,
      });
      await this.applyGuaranteed(session, userId, request.scrollId, rolls);
      const created = await this.characterGrants.grant(session, userId, rolls, request.target, SummonError.ROSTER_FULL);

      const grants: SummonGrantDto[] = created.map((record) => ({
        uid: record.uid,
        characterId: record.characterId,
        stars: record.stars,
        level: record.level,
        exp: record.currentExp,
        currentExp: record.currentExp,
        awakened: record.awakeningIndex > 0,
        skillLevels: record.skillLevels,
        awakeningIndex: record.awakeningIndex,
      }));

      return {
        ok: true as const,
        scrollId: request.scrollId,
        currencyId: economy.currencyId,
        spent: cost,
        walletAfter: Object.keys(walletAfter).length > 0 ? walletAfter : { [economy.currencyId]: (await this.ledger.snapshot(userId, session))[economy.currencyId] ?? 0 },
        // Read inside the transaction: the stored response is the one the first call answered.
        wallet: await this.ledger.snapshot(userId, session),
        grants,
        target: request.target,
      };
    });

    if (!replayed) {
      await this.rosterCache.invalidate(userId);
      await this.activity.record(userId, "summon", result.grants.length);
    }
    return result;
  }

  /**
   * Tutorial guaranteed summons: the first summons of the account with this scroll give the configured monsters in
   * order (natural stars), replacing the rolls; counts every summon of the scroll.
   */
  private async applyGuaranteed(session: DbSession, userId: string, scrollId: string, rolls: Array<{ characterId: string; stars: number }>): Promise<void> {
    if (!this.counters) return;
    const guaranteed = this.scrolls.guaranteed?.(scrollId) ?? [];
    const done = guaranteed.length > 0 ? await this.counters.count(userId, scrollId, session) : 0;
    for (let i = 0; i < rolls.length && done + i < guaranteed.length; i++) {
      const character = this.characterRules.get(guaranteed[done + i]);
      if (!character) throw new AppError(SummonError.CHAR_NOT_IN_CATALOG);
      rolls[i] = { characterId: character.id, stars: character.naturalStars ?? 3 };
    }
    await this.counters.add(userId, scrollId, rolls.length, session);
  }

  /** Rolls a pool, then a character (natural stars from the catalog). */
  private roll(scrollId: string): { characterId: string; stars: number } {
    const scroll = this.scrolls.get(scrollId);
    if (!scroll) throw new AppError(SummonError.SCROLL_NOT_FOUND);

    let pool;
    let entry;
    try {
      pool = pickWeighted(this.random, scroll.pools ?? []);
      if (!pool?.entries?.length) throw new AppError(SummonError.EMPTY_POOL);
      entry = pickWeighted(this.random, pool.entries);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(SummonError.INVALID_WEIGHT_LIST);
    }

    const character = this.characterRules.get(entry.characterId);
    if (!character) throw new AppError(SummonError.CHAR_NOT_IN_CATALOG);

    return { characterId: entry.characterId, stars: character.naturalStars ?? pool.minStars ?? 3 };
  }
}
