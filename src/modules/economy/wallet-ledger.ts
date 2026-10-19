import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { CurrencyAmount, WalletSnapshot } from "../../shared/kernel/types.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import { applyRecharge, creditedAmount, mergeAmounts } from "./economy.domain.js";
import type { CurrencyRules, WalletRepository } from "./economy.ports.js";
import { toWalletSnapshot } from "./economy.mapper.js";

export type DebitOptions = {
  /** Error code thrown when a balance is too low (default ECON_INSUFFICIENT_FUNDS). */
  insufficientError?: string;
};

/**
 * Wallet mutations shared by every feature (summon, runes, shop, rewards...). Always runs inside the
 * caller's transaction and locks the touched rows, so a use case's spend + grant is atomic.
 */
export class WalletLedger {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly currencies: CurrencyRules,
    private readonly clock: Clock,
  ) {}

  /**
   * Removes `costs` from the wallet (pending recharge is applied first). Throws when any balance is
   * insufficient. Returns the new balances of the touched currencies.
   */
  async debit(session: DbSession, userId: string, costs: ReadonlyArray<CurrencyAmount>, options: DebitOptions = {}): Promise<WalletSnapshot> {
    const merged = mergeAmounts(costs);
    if (merged.size === 0) return {};

    const rows = await this.wallets.lockRows(userId, [...merged.keys()], session);
    const level = await this.levelIfNeeded(userId, [...merged.keys()], session);
    const nowMs = this.clock.nowMs();
    const result: WalletSnapshot = {};

    for (const [currencyId, amount] of merged) {
      const row = rows.get(currencyId) ?? { currencyId, amount: 0, lastTickAt: null };
      const cfg = this.currencies.get(currencyId);
      if (cfg) applyRecharge(row, cfg, level, nowMs);
      if (row.amount < amount) {
        throw new AppError(options.insufficientError ?? ErrorCode.ECON_INSUFFICIENT_FUNDS, {
          extra: { currencyId, need: amount, have: row.amount },
        });
      }
      row.amount -= amount;
      rows.set(currencyId, row);
    }

    for (const currencyId of merged.keys()) {
      const row = rows.get(currencyId)!;
      await this.wallets.saveRow(userId, row, session);
      result[currencyId] = row.amount;
    }

    return result;
  }

  /** Adds `grants` respecting caps (never lowering a balance). Returns the new touched balances. */
  async credit(session: DbSession, userId: string, grants: ReadonlyArray<CurrencyAmount>): Promise<WalletSnapshot> {
    const merged = mergeAmounts(grants);
    if (merged.size === 0) return {};

    const rows = await this.wallets.lockRows(userId, [...merged.keys()], session);
    const level = await this.levelIfNeeded(userId, [...merged.keys()], session);
    const nowMs = this.clock.nowMs();
    const result: WalletSnapshot = {};

    for (const [currencyId, amount] of merged) {
      const row = rows.get(currencyId) ?? { currencyId, amount: 0, lastTickAt: null };
      const cfg = this.currencies.get(currencyId);
      if (cfg) applyRecharge(row, cfg, level, nowMs);
      row.amount = creditedAmount(row.amount, amount, cfg, level);
      await this.wallets.saveRow(userId, row, session);
      result[currencyId] = row.amount;
    }

    return result;
  }

  /** Locks the given currencies and returns their balances (pending recharge applied and saved). */
  async lockedBalances(session: DbSession, userId: string, currencyIds: string[]): Promise<WalletSnapshot> {
    const ids = [...new Set(currencyIds.filter((id) => !!id))];
    if (ids.length === 0) return {};

    const rows = await this.wallets.lockRows(userId, ids, session);
    const level = await this.levelIfNeeded(userId, ids, session);
    const nowMs = this.clock.nowMs();
    const result: WalletSnapshot = {};

    for (const id of ids) {
      const row = rows.get(id) ?? { currencyId: id, amount: 0, lastTickAt: null };
      const cfg = this.currencies.get(id);
      if (cfg && applyRecharge(row, cfg, level, nowMs)) await this.wallets.saveRow(userId, row, session);
      result[id] = row.amount;
    }
    return result;
  }

  /** Current balances (no recharge applied). */
  async snapshot(userId: string, session?: DbSession): Promise<WalletSnapshot> {
    return toWalletSnapshot(await this.wallets.listWallet(userId, session));
  }

  private async levelIfNeeded(userId: string, currencyIds: string[], session: DbSession): Promise<number> {
    const needsLevel = currencyIds.some((id) => {
      const cfg = this.currencies.get(id);
      return !!cfg && cfg.hasCap && cfg.capScalesWithLevel;
    });
    return needsLevel ? this.wallets.getAccountLevel(userId, session) : 1;
  }
}
