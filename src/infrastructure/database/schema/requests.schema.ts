// Idempotency: the response of a mutation, stored per (user, client request id) in the SAME transaction as the
// mutation, so a retried request (timeout, reconnect) returns the stored response instead of running again.
// Purged by the retention job (`requestResultDays`).
import { mysqlTable, char, varchar, json, datetime, primaryKey, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

export const userRequestResults = mysqlTable("user_request_results", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Client generated id, 1..64 characters of [A-Za-z0-9_-]. */
  requestId: varchar("request_id", { length: 64 }).notNull(),
  /** summon | power_up | evolve | awaken | rune_upgrade | stage_start | roster_sell | roster_expand */
  kind: varchar("kind", { length: 32 }).notNull(),
  /** The response the first call answered (null only inside the transaction that is still running). */
  response: json("response"),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  primaryKey({ columns: [t.userId, t.requestId] }),
  index("idx_request_results_created").on(t.createdAt),
]);
