// src/modules/rune/rune.service.ts
// Rune use cases: search, counts, grant (GM/dev/rewards), equip, upgrade, sell, delete, lock, favorite.

import { noActivity, type PlayerActivitySink } from "../../shared/kernel/activity.js";
import { ulid } from "ulid";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { Idempotency } from "../../shared/kernel/idempotency.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { RuneCache } from "./rune.cache.js";
import type { RuneSearchItemDto, RuneSellResultDto, RuneSetCountDto, RuneSyncDto, RuneUpgradeResultDto } from "./rune.dto.js";
import type { RuneGenerator, RuneSpec } from "./rune.generator.js";
import { toRuneSearchItem, toRuneSyncDto } from "./rune.mapper.js";
import type { RuneRecord, RuneRepository, RuneRules, RuneSearchFilters } from "./rune.ports.js";

/** Default rune inventory size for new players. */
export const DEFAULT_RUNE_CAPACITY = 200;

export type GrantRunesOptions = {
  /** What to do when the inventory is full: fail the whole operation or skip the extra runes. */
  whenFull: "throw" | "skip";
};

export function computeSellPrice(rune: Pick<RuneRecord, "tier" | "quality" | "level">, currencyId: string): { currencyId: string; amount: number } {
  const base = 100 * Math.max(1, rune.tier) * Math.max(1, rune.quality);
  return { currencyId, amount: base + 50 * Math.max(0, rune.level) };
}

export class RuneService {
  constructor(
    private readonly runes: RuneRepository,
    private readonly generator: RuneGenerator,
    private readonly rules: RuneRules,
    private readonly ledger: WalletLedger,
    private readonly cache: RuneCache,
    private readonly uow: UnitOfWork,
    /** Receives `rune_upgrade` (one per attempt, success or not) for the guild quests. */
    private readonly activity: PlayerActivitySink = noActivity,
    /** Stored responses of repeated `requestId`s (upgrade); default: no idempotency. */
    private readonly idempotency: Idempotency = new Idempotency(null, uow),
  ) {}

  async search(userId: string, filters: Omit<RuneSearchFilters, "pageSize"> & { pageSize?: number | null }): Promise<RuneSearchItemDto[]> {
    const pageSize = Math.max(1, Math.min(200, Number(filters.pageSize ?? 60) || 60));
    return (await this.runes.search(userId, { ...filters, pageSize })).map(toRuneSearchItem);
  }

  async setCounts(userId: string): Promise<RuneSetCountDto[]> {
    const cached = await this.cache.getSetCounts(userId);
    if (cached) return cached;

    const token = await this.cache.token(userId); // before the database read (see VersionedCache)
    const counts = (await this.runes.freeCountsBySet(userId)).map((entry) => ({ setId: entry.setId, freeCount: entry.count }));
    await this.cache.setSetCounts(userId, counts, token);
    return counts;
  }

  /** Creates runes inside the caller's transaction (rewards, shop, GM grants). */
  async grantRunes(session: DbSession, userId: string, specs: RuneSpec[], options: GrantRunesOptions): Promise<RuneSyncDto[]> {
    if (specs.length === 0) return [];

    const { capacity, count } = await this.runes.lockCapacity(userId, DEFAULT_RUNE_CAPACITY, session);
    const free = Math.max(0, capacity - count);
    if (free < specs.length && options.whenFull === "throw") throw new AppError(ErrorCode.RUNE_CAPACITY_FULL);

    const granted: RuneSyncDto[] = [];
    for (const spec of specs.slice(0, free)) {
      const rune = this.generator.generate(spec, ulid());
      await this.runes.insertRune(userId, rune, session);
      granted.push(toRuneSyncDto(rune));
    }
    return granted;
  }

  /** Creates one rune in its own transaction. */
  async grant(userId: string, spec: RuneSpec): Promise<RuneSyncDto> {
    const [rune] = await this.uow.transaction((session) => this.grantRunes(session, userId, [spec], { whenFull: "throw" }));
    await this.cache.invalidate(userId);
    return rune;
  }

  async equip(userId: string, runeUid: string, characterUid: string): Promise<void> {
    await this.uow.transaction(async (session) => {
      if (!(await this.runes.characterExists(userId, characterUid, session))) throw new AppError(ErrorCode.ROSTER_CHARACTER_NOT_FOUND);

      const rune = await this.runes.find(userId, runeUid, session, true);
      if (!rune) throw new AppError(ErrorCode.RUNE_NOT_FOUND);

      await this.runes.clearSlot(userId, characterUid, rune.slot, session);
      await this.runes.setEquipped(userId, runeUid, characterUid, session);
    });
    await this.cache.invalidate(userId);
  }

  async unequip(userId: string, characterUid: string, slot: number): Promise<void> {
    await this.uow.transaction(async (session) => {
      if (!(await this.runes.characterExists(userId, characterUid, session))) throw new AppError(ErrorCode.ROSTER_CHARACTER_NOT_FOUND);
      await this.runes.clearSlot(userId, characterUid, slot, session);
    });
    await this.cache.invalidate(userId);
  }

  async upgrade(userId: string, runeUid: string, requestId?: string): Promise<RuneUpgradeResultDto> {
    const repeated = await this.idempotency.replay<RuneUpgradeResultDto>(userId, requestId, "rune_upgrade");
    if (repeated) return repeated;
    const currencyId = this.rules.upgradeCurrencyId();

    const { value: result, replayed } = await this.idempotency.run<RuneUpgradeResultDto>(userId, requestId, "rune_upgrade", async (session) => {
      const rune = await this.runes.find(userId, runeUid, session, true);
      if (!rune) throw new AppError(ErrorCode.RUNE_NOT_FOUND);
      if (rune.level >= this.rules.catalog().config.maxLevel) throw new AppError(ErrorCode.RUNE_AT_MAX_LEVEL);

      const cost = this.rules.upgradeCost(rune.level) || 0;
      let walletAfter: number | null = null;
      if (cost > 0) {
        walletAfter = (await this.ledger.debit(session, userId, [{ currencyId, amount: cost }]))[currencyId];
      }

      const rolled = this.generator.rollUpgrade(rune);
      if (rolled.success) {
        await this.runes.updateProgress(userId, runeUid, rolled.level, rolled.mainStatValue, rolled.substats, session);
      }

      const updated: RuneRecord = { ...rune, level: rolled.level, mainStatValue: rolled.mainStatValue, substats: rolled.substats };
      return { success: rolled.success, rune: toRuneSyncDto(updated), spend: cost, currencyId, walletAfter, wallet: await this.ledger.snapshot(userId, session) };
    });

    if (!replayed) {
      await this.cache.invalidate(userId);
      await this.activity.record(userId, "rune_upgrade");
    }
    return result;
  }

  async sell(userId: string, runeUid: string): Promise<RuneSellResultDto> {
    const result = await this.uow.transaction(async (session) => {
      const rune = await this.runes.find(userId, runeUid, session, true);
      if (!rune) throw new AppError(ErrorCode.RUNE_NOT_FOUND);
      if (rune.locked) throw new AppError(ErrorCode.RUNE_LOCKED);
      if (rune.equippedToUid) throw new AppError(ErrorCode.RUNE_ALREADY_EQUIPPED);

      const price = computeSellPrice(rune, this.rules.upgradeCurrencyId());
      const balances = await this.ledger.credit(session, userId, [price]);
      await this.runes.delete(userId, runeUid, session);
      return { removedUid: runeUid, currencyId: price.currencyId, gained: price.amount, walletAfter: balances[price.currencyId] ?? 0 };
    });

    // Selling is not an upgrade attempt: no `rune_upgrade` activity (missions / quests / achievements).
    await this.cache.invalidate(userId);
    return { ...result, wallet: await this.ledger.snapshot(userId) };
  }

  /**
   * Destroys a rune without any refund. Same protections as `sell`: unknown/foreign runes answer `RUNE_NOT_FOUND`,
   * locked runes `RUNE_LOCKED`, equipped runes `RUNE_ALREADY_EQUIPPED` (unequip first).
   */
  async remove(userId: string, runeUid: string): Promise<{ removedUid: string }> {
    await this.uow.transaction(async (session) => {
      const rune = await this.runes.find(userId, runeUid, session, true);
      if (!rune) throw new AppError(ErrorCode.RUNE_NOT_FOUND);
      if (rune.locked) throw new AppError(ErrorCode.RUNE_LOCKED);
      if (rune.equippedToUid) throw new AppError(ErrorCode.RUNE_ALREADY_EQUIPPED);
      if ((await this.runes.delete(userId, runeUid, session)) !== 1) throw new AppError(ErrorCode.RUNE_DELETE_FAILED);
    });
    await this.cache.invalidate(userId);
    return { removedUid: runeUid };
  }

  /**
   * Locks/unlocks a rune (idempotent). A locked rune cannot be sold or deleted; it can still be equipped,
   * unequipped and upgraded. Flags do not change the free counts, so the counts cache is kept.
   */
  async setLock(userId: string, runeUid: string, locked: boolean): Promise<{ runeUid: string; locked: boolean }> {
    if ((await this.runes.setFlags(userId, runeUid, { locked })) !== 1) throw new AppError(ErrorCode.RUNE_NOT_FOUND);
    return { runeUid, locked };
  }

  /** Marks/unmarks a rune as favorite (idempotent, display only: clients list favorites first). */
  async setFavorite(userId: string, runeUid: string, favorite: boolean): Promise<{ runeUid: string; favorite: boolean }> {
    if ((await this.runes.setFlags(userId, runeUid, { favorite })) !== 1) throw new AppError(ErrorCode.RUNE_NOT_FOUND);
    return { runeUid, favorite };
  }

  /** Runes equipped on the given characters (battle stat building). */
  listEquippedOn(userId: string, characterUids: string[]): Promise<RuneRecord[]> {
    return this.runes.listEquippedOn(userId, characterUids);
  }
}
