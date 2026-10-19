import { and, eq, inArray } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userCurrencies, userProfile } from "../../infrastructure/database/schema/index.js";
import type { WalletRepository, WalletRow } from "./economy.ports.js";

const walletColumns = { currencyId: userCurrencies.currencyId, amount: userCurrencies.amount, lastTickAt: userCurrencies.lastTickAt };

/** Drizzle implementation of {@link WalletRepository} (`user_currencies`). */
export class DrizzleWalletRepository extends DrizzleRepository implements WalletRepository {
  constructor(database: Database) {
    super(database);
  }

  async listWallet(userId: string, session?: DbSession): Promise<WalletRow[]> {
    return this.db(session).select(walletColumns).from(userCurrencies).where(eq(userCurrencies.userId, userId));
  }

  async insertMissing(userId: string, rows: WalletRow[], session?: DbSession): Promise<void> {
    if (rows.length === 0) return;
    await this.db(session).insert(userCurrencies).ignore()
      .values(rows.map((row) => ({ userId, currencyId: row.currencyId, amount: row.amount, lastTickAt: row.lastTickAt })));
  }

  async lockRows(userId: string, currencyIds: string[], session: DbSession): Promise<Map<string, WalletRow>> {
    const ids = [...new Set(currencyIds)];
    const result = new Map<string, WalletRow>();
    if (ids.length === 0) return result;

    const db = this.db(session);
    await db.insert(userCurrencies).ignore().values(ids.map((currencyId) => ({ userId, currencyId, amount: 0 })));
    const rows = await db.select(walletColumns).from(userCurrencies)
      .where(and(eq(userCurrencies.userId, userId), inArray(userCurrencies.currencyId, ids)))
      .for("update");
    for (const row of rows) result.set(row.currencyId, row);
    return result;
  }

  async saveRow(userId: string, row: WalletRow, session?: DbSession): Promise<void> {
    await this.db(session).update(userCurrencies)
      .set({ amount: row.amount, lastTickAt: row.lastTickAt })
      .where(and(eq(userCurrencies.userId, userId), eq(userCurrencies.currencyId, row.currencyId)));
  }

  async getAccountLevel(userId: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ level: userProfile.level }).from(userProfile).where(eq(userProfile.userId, userId)).limit(1);
    return row?.level ?? 1;
  }
}

