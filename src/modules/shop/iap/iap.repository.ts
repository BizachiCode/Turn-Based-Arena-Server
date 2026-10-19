import { eq } from "drizzle-orm";
import type { DbSession } from "../../../shared/kernel/unit-of-work.js";
import type { Database } from "../../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../../infrastructure/database/drizzle-unit-of-work.js";
import { userIapTransactions } from "../../../infrastructure/database/schema/index.js";
import { isDuplicateKeyError } from "../../../shared/errors/db-errors.js";
import type { IapTransactionRecord, IapTransactionRepository } from "./iap.ports.js";

export class DrizzleIapTransactionRepository extends DrizzleRepository implements IapTransactionRepository {
  constructor(database: Database) {
    super(database);
  }

  async findOwner(transactionKey: string, session?: DbSession): Promise<{ userId: string; purchaseId: string } | null> {
    const [row] = await this.db(session)
      .select({ userId: userIapTransactions.userId, purchaseId: userIapTransactions.purchaseId })
      .from(userIapTransactions)
      .where(eq(userIapTransactions.transactionKey, transactionKey))
      .limit(1);
    return row ?? null;
  }

  async insert(record: IapTransactionRecord, session: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(userIapTransactions).values(record);
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }
}
