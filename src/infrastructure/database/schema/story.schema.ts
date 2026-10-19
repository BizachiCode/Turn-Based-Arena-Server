// Story/tutorial progress: completed dialogue sequences and the sequence in progress (resume after a restart).
import { mysqlTable, char, varchar, int, tinyint, datetime, primaryKey } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

/** One row per dialogue sequence the player completed (rewards are granted when the row is created). */
export const userStoryProgress = mysqlTable("user_story_progress", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  dialogueId: varchar("dialogue_id", { length: 64 }).notNull(),
  /** 1 when the player skipped it. */
  skipped: tinyint("skipped").notNull().default(0),
  /** Times completed (repeatable sequences). */
  times: int("times").notNull().default(1),
  completedAt: datetime("completed_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.dialogueId] }),
]);

/** The sequence the player is in the middle of (one per player). */
export const userStoryActive = mysqlTable("user_story_active", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  dialogueId: varchar("dialogue_id", { length: 64 }).notNull(),
  step: int("step").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});
