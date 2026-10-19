// Player inventory: wallet, characters (+capacity), runes (+capacity).
import { mysqlTable, char, varchar, tinyint, smallint, int, bigint, datetime, json, mysqlEnum, primaryKey, uniqueIndex, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const userCurrencies = mysqlTable("user_currencies", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  currencyId: varchar("currency_id", { length: 64 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  lastTickAt: datetime("last_tick_at"),
}, (t) => [
  primaryKey({ columns: [t.userId, t.currencyId] }),
]);

export const userCharacters = mysqlTable("user_characters", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  /** Public ULID used by the client. */
  publicUid: char("public_uid", { length: 26 }).notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  characterId: varchar("character_id", { length: 64 }).notNull(),
  stars: tinyint("stars").notNull().default(1),
  level: smallint("level").notNull().default(1),
  currentExp: bigint("current_exp", { mode: "number" }).notNull().default(0),
  awakeningIndex: tinyint("awakening_index").notNull().default(0),
  skillLevels: json("skill_levels"),
  locked: tinyint("locked").notNull().default(0),
  favorite: tinyint("favorite").notNull().default(0),
  location: mysqlEnum("location", ["BAG", "STORAGE"]).notNull().default("BAG"),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  uniqueIndex("uq_uc_public_uid").on(t.publicUid),
  index("idx_uc_user_char").on(t.userId, t.characterId),
  index("idx_uc_user_loc_id").on(t.userId, t.location, t.id),
]);

export const userCharacterCapacity = mysqlTable("user_character_capacity", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  bagCapacity: int("bag_capacity").notNull().default(100),
  storageCapacity: int("storage_capacity").notNull().default(500),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});

export const userRunes = mysqlTable("user_runes", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  publicUid: char("public_uid", { length: 26 }).notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  setId: varchar("set_id", { length: 64 }).notNull(),
  slot: tinyint("slot").notNull(),
  tier: tinyint("tier").notNull(),
  variant: varchar("variant", { length: 32 }).notNull(),
  /** 1 = Normal .. 5 = Legendary. */
  quality: tinyint("quality").notNull(),
  level: tinyint("level").notNull().default(0),
  mainStatType: varchar("main_stat_type", { length: 32 }).notNull(),
  mainStatValue: int("main_stat_value").notNull().default(0),
  substats: json("substats"),
  origin: varchar("origin", { length: 32 }),
  locked: tinyint("locked").notNull().default(0),
  favorite: tinyint("favorite").notNull().default(0),
  equippedToUid: char("equipped_to_uid", { length: 26 }).references(() => userCharacters.publicUid, { onDelete: "set null" }),
  equippedAt: datetime("equipped_at"),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  uniqueIndex("uq_ur_public_uid").on(t.publicUid),
  uniqueIndex("uq_ur_equipped_char_slot").on(t.equippedToUid, t.slot),
  index("idx_ur_user_set").on(t.userId, t.setId, t.id),
  index("idx_ur_user_slot").on(t.userId, t.slot, t.id),
]);

export const userRuneCapacity = mysqlTable("user_rune_capacity", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  runeCapacity: int("rune_capacity").notNull().default(200),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});
