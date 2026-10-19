// Daily attendance (check-in): days claimed since the account started checking in and the last claimed game day.
import { mysqlTable, char, varchar, int, datetime } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const userAttendance = mysqlTable("user_attendance", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Total check-ins (the day of the cycle is `claimedDays % cycle length`). */
  claimedDays: int("claimed_days").notNull().default(0),
  /** Game day (`YYYY-MM-DD`) of the last check-in. */
  lastClaimDay: varchar("last_claim_day", { length: 10 }),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});
