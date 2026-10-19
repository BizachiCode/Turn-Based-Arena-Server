// Server log entries shown in the GM panel "Logs" view (see src/shared/log). Written in batches by the log sink; the
// ring buffer in memory answers the newest entries when the database is unavailable. Purged by the retention job.
import { mysqlTable, bigint, char, varchar, text, int, datetime, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

export const serverLogs = mysqlTable("server_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  /** Millisecond precision: entries of the same second keep their order. */
  createdAt: datetime("created_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  /** debug | info | warn | error */
  level: varchar("level", { length: 8 }).notNull(),
  /** The "[Tag]" prefix of the message (logger scope), empty when there was none. */
  scope: varchar("scope", { length: 48 }).notNull().default(""),
  message: varchar("message", { length: 2000 }).notNull(),
  /** Stack trace and/or extra arguments (text, may be multi-line). */
  details: text("details"),
  /** Player the entry is about, when known. */
  userId: char("user_id", { length: 36 }),
  /** Room name the entry came from, when known. */
  room: varchar("room", { length: 32 }),
  /** How many identical consecutive entries were folded into this one (flood aggregation). */
  repeats: int("repeats").notNull().default(1),
  /** Process id (several pm2 instances write to the same table). */
  pid: int("pid").notNull().default(0),
}, (t) => [
  index("idx_server_logs_created").on(t.createdAt),
  index("idx_server_logs_level").on(t.level, t.id),
  index("idx_server_logs_scope").on(t.scope, t.id),
]);
