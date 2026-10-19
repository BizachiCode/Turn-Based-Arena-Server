// Towers (Spire of Trials): floors cleared per player, tower region and season (`M:2026-10`, `W:2026-10-05`, `all`).
import { mysqlTable, char, varchar, int, datetime, primaryKey, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const userTowerProgress = mysqlTable("user_tower_progress", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  regionId: varchar("region_id", { length: 64 }).notNull(),
  seasonKey: varchar("season_key", { length: 16 }).notNull(),
  clearedFloors: int("cleared_floors").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.regionId, t.seasonKey] }),
  /** Tower ranking: floors of one tower and season. */
  index("idx_tower_region_season").on(t.regionId, t.seasonKey, t.clearedFloors),
]);
