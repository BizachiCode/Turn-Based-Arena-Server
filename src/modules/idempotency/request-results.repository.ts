// Drizzle adapter of the idempotency store (`user_request_results`).

import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userRequestResults } from "../../infrastructure/database/schema/index.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { RequestResultStore, StoredRequestResult } from "../../shared/kernel/idempotency.js";

export class DrizzleRequestResultStore extends DrizzleRepository implements RequestResultStore {
  constructor(database: Database) {
    super(database);
  }

  async find(userId: string, requestId: string, session?: DbSession): Promise<StoredRequestResult | null> {
    const [row] = await this.db(session).select({ kind: userRequestResults.kind, response: userRequestResults.response })
      .from(userRequestResults)
      .where(and(eq(userRequestResults.userId, userId), eq(userRequestResults.requestId, requestId)))
      .limit(1);
    if (!row) return null;
    return { kind: row.kind, response: parseResponse(row.response) };
  }

  async claim(userId: string, requestId: string, kind: string, session: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(userRequestResults).values({ userId, requestId, kind, response: null });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async complete(userId: string, requestId: string, response: unknown, session: DbSession): Promise<void> {
    await this.db(session).update(userRequestResults).set({ response })
      .where(and(eq(userRequestResults.userId, userId), eq(userRequestResults.requestId, requestId)));
  }
}

/** MariaDB returns JSON columns as text; MySQL as parsed values. */
function parseResponse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
