// Daily missions and achievements: progress per player, mission and period (`YYYY-MM-DD` game day for the daily
// missions and the daily bonus, `all` for achievements), with the claim date.
import { mysqlTable, char, varchar, int, datetime, primaryKey, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const userMissionProgress = mysqlTable("user_mission_progress", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  missionId: varchar("mission_id", { length: 64 }).notNull(),
  periodKey: varchar("period_key", { length: 16 }).notNull(),
  progress: int("progress").notNull().default(0),
  claimedAt: datetime("claimed_at"),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.missionId, t.periodKey] }),
  index("idx_mission_user_period").on(t.userId, t.periodKey),
]);
