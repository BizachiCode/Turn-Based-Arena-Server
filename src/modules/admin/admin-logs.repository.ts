import { and, desc, eq, gte, inArray, like, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { serverLogs } from "../../infrastructure/database/schema/index.js";
import { LOG_LEVELS, type LogLevel } from "../../shared/log/log-types.js";
import type { AdminLogLevelCounts, AdminLogQuery, AdminLogRow, AdminLogsRepository } from "./admin-logs.ports.js";

const MAX_SCOPES = 200;

/** Escapes `\`, `%` and `_` so user text matches literally in a LIKE pattern. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class DrizzleAdminLogsRepository extends DrizzleRepository implements AdminLogsRepository {
  constructor(database: Database) {
    super(database);
  }

  async query(query: AdminLogQuery): Promise<AdminLogRow[]> {
    const conditions: SQL[] = [];
    if (query.levels.length > 0) conditions.push(inArray(serverLogs.level, query.levels));
    if (query.scope) conditions.push(eq(serverLogs.scope, query.scope));
    if (query.q) {
      const pattern = likePattern(query.q);
      const match = or(like(serverLogs.message, pattern), like(serverLogs.details, pattern));
      if (match) conditions.push(match);
    }
    if (query.from) conditions.push(gte(serverLogs.createdAt, query.from));
    if (query.to) conditions.push(lte(serverLogs.createdAt, query.to));
    if (query.before) conditions.push(lt(serverLogs.id, query.before));

    const rows = await this.database.select().from(serverLogs)
      .where(and(...conditions)).orderBy(desc(serverLogs.id)).limit(Math.max(1, Math.min(200, query.limit)));
    return rows.map((row) => ({
      id: row.id,
      time: row.createdAt.toISOString(),
      level: row.level as LogLevel,
      scope: row.scope,
      message: row.message,
      details: row.details,
      userId: row.userId,
      room: row.room,
      repeats: row.repeats,
      pid: row.pid,
    }));
  }

  async levelCounts(since: Date): Promise<AdminLogLevelCounts> {
    const rows = await this.database.select({ level: serverLogs.level, total: sql<number>`coalesce(sum(${serverLogs.repeats}), 0)` })
      .from(serverLogs).where(gte(serverLogs.createdAt, since)).groupBy(serverLogs.level);
    const counts: AdminLogLevelCounts = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of rows) {
      if ((LOG_LEVELS as readonly string[]).includes(row.level)) counts[row.level as LogLevel] = Number(row.total);
    }
    return counts;
  }

  async scopes(since: Date, limit: number): Promise<Array<{ scope: string; count: number }>> {
    const total = sql<number>`coalesce(sum(${serverLogs.repeats}), 0)`;
    const rows = await this.database.select({ scope: serverLogs.scope, total }).from(serverLogs)
      .where(gte(serverLogs.createdAt, since)).groupBy(serverLogs.scope).orderBy(desc(total)).limit(Math.max(1, Math.min(MAX_SCOPES, limit)));
    return rows.map((row) => ({ scope: row.scope, count: Number(row.total) }));
  }
}
