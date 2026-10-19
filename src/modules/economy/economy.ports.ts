import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { CurrencyCfg } from "../../config/CurrencyCatalog.js";

/** One wallet entry as persisted. */
export type WalletRow = {
  currencyId: string;
  amount: number;
  lastTickAt: Date | null;
};

/** Persistence port for player wallets. */
export interface WalletRepository {
  listWallet(userId: string, session?: DbSession): Promise<WalletRow[]>;
  /** Inserts rows that don't exist yet (existing rows are left untouched). */
  insertMissing(userId: string, rows: WalletRow[], session?: DbSession): Promise<void>;
  /** Locks (SELECT ... FOR UPDATE) the given currencies, creating zero rows for missing ones. */
  lockRows(userId: string, currencyIds: string[], session: DbSession): Promise<Map<string, WalletRow>>;
  /** Persists amount + lastTickAt of one row. */
  saveRow(userId: string, row: WalletRow, session?: DbSession): Promise<void>;
  /** Account level (drives level-scaled currency caps). */
  getAccountLevel(userId: string, session?: DbSession): Promise<number>;
}

/** Read access to the currency rules exported from Unity (`currencies.json`). */
export interface CurrencyRules {
  get(currencyId: string): CurrencyCfg | undefined;
  list(): CurrencyCfg[];
}
