// Persistence adapter of the log sink: batched inserts into `server_logs` and the retention purge.

import { lt } from "drizzle-orm";
import type { Database } from "../database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../database/drizzle-unit-of-work.js";
import { serverLogs } from "../database/schema/index.js";
import type { LogRecord, LogStore } from "../../shared/log/log-types.js";

export class DrizzleLogStore extends DrizzleRepository implements LogStore {
  constructor(database: Database) {
    super(database);
  }

  async insertMany(records: readonly LogRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.database.insert(serverLogs).values(records.map((record) => ({
      createdAt: new Date(record.time),
      level: record.level,
      scope: record.scope,
      message: record.message,
      details: record.details,
      userId: record.userId,
      room: record.room,
      repeats: record.repeats,
      pid: record.pid,
    })));
  }

  /** Deletes entries older than `cutoff` (batched by the caller); returns the rows removed. */
  async purgeBefore(cutoff: Date, limit: number): Promise<number> {
    return affectedRows(await this.database.delete(serverLogs).where(lt(serverLogs.createdAt, cutoff)).limit(limit));
  }
}
