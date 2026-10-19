import { and, eq, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userSummonCounters } from "../../infrastructure/database/schema/index.js";
import type { SummonCounterRepository } from "./summon.ports.js";

export class DrizzleSummonCounterRepository extends DrizzleRepository implements SummonCounterRepository {
  constructor(database: Database) {
    super(database);
  }

  async count(userId: string, scrollId: string, session: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ summons: userSummonCounters.summons }).from(userSummonCounters)
      .where(and(eq(userSummonCounters.userId, userId), eq(userSummonCounters.scrollId, scrollId)))
      .limit(1).for("update");
    return row?.summons ?? 0;
  }

  async add(userId: string, scrollId: string, amount: number, session: DbSession): Promise<void> {
    await this.db(session).insert(userSummonCounters).values({ userId, scrollId, summons: amount })
      .onDuplicateKeyUpdate({ set: { summons: sql`${userSummonCounters.summons} + ${amount}` } });
  }
}
