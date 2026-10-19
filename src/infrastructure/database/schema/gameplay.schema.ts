// Gameplay progress: map/stages, PvE battles (tickets + idempotent rewards), home, chat, shop.
import { mysqlTable, char, varchar, tinyint, int, bigint, float, datetime, json, mysqlEnum, primaryKey, uniqueIndex, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;
const DIFFICULTIES = ["Easy", "Normal", "Hard", "Hell"] as const;

export const userStageProgress = mysqlTable("user_stage_progress", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  regionId: varchar("region_id", { length: 64 }).notNull(),
  stageId: varchar("stage_id", { length: 64 }).notNull(),
  difficulty: mysqlEnum("difficulty", DIFFICULTIES).notNull(),
  firstClearAt: datetime("first_clear_at"),
  bestClearMs: int("best_clear_ms"),
  clears: int("clears").notNull().default(0),
  lastPlayedAt: datetime("last_played_at").notNull().default(now),
}, (t) => [
  primaryKey({ columns: [t.userId, t.regionId, t.stageId, t.difficulty] }),
]);

export const userMapPrefs = mysqlTable("user_map_prefs", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  lastRegionId: varchar("last_region_id", { length: 64 }),
  lastStageId: varchar("last_stage_id", { length: 64 }),
  lastDifficulty: mysqlEnum("last_difficulty", DIFFICULTIES),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});

/**
 * One row per paid stage entry. `stage/validateStart` creates a TICKET (energy already spent);
 * `battle_start` consumes it (STARTED + battle_id); the final frame moves it to VICTORY/DEFEAT.
 * Rewards are granted exactly once per row (status transition guarded by a row lock).
 */
export const pveBattles = mysqlTable("pve_battles", {
  id: char("id", { length: 26 }).primaryKey().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  regionId: varchar("region_id", { length: 64 }).notNull(),
  stageId: varchar("stage_id", { length: 64 }).notNull(),
  difficulty: mysqlEnum("difficulty", DIFFICULTIES).notNull(),
  status: mysqlEnum("status", ["TICKET", "STARTED", "VICTORY", "DEFEAT", "EXPIRED"]).notNull().default("TICKET"),
  currencyId: varchar("currency_id", { length: 64 }),
  energySpent: int("energy_spent").notNull().default(0),
  battleId: char("battle_id", { length: 26 }),
  createdAt: datetime("created_at").notNull().default(now),
  startedAt: datetime("started_at"),
  finishedAt: datetime("finished_at"),
  result: json("result"),
}, (t) => [
  uniqueIndex("uq_pve_battle_id").on(t.battleId),
  index("idx_pve_user_status").on(t.userId, t.status, t.createdAt),
]);

export const userHomePrefs = mysqlTable("user_home_prefs", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  selectedIslandId: varchar("selected_island_id", { length: 64 }),
  /** Monotonic counter bumped by every home mutation. */
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});

export const userHomeObjects = mysqlTable("user_home_objects", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  instanceId: varchar("instance_id", { length: 80 }).notNull(),
  islandId: varchar("island_id", { length: 64 }).notNull(),
  definitionId: varchar("definition_id", { length: 64 }).notNull(),
  templateInstanceId: varchar("template_instance_id", { length: 80 }),
  state: mysqlEnum("state", ["ACTIVE", "REMOVED"]).notNull().default("ACTIVE"),
  originX: int("origin_x").notNull().default(0),
  originZ: int("origin_z").notNull().default(0),
  yawDegrees: float("yaw_degrees").notNull().default(0),
  isTemplateObject: tinyint("is_template_object").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  uniqueIndex("uq_uho_user_instance").on(t.userId, t.instanceId),
  uniqueIndex("uq_uho_user_template").on(t.userId, t.templateInstanceId),
  index("idx_uho_user_island").on(t.userId, t.islandId),
]);

/** Home islands the player bought (`unlock_island`); islands with `unlockedByDefault` need no row. */
export const userHomeIslands = mysqlTable("user_home_islands", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  islandId: varchar("island_id", { length: 64 }).notNull(),
  unlockedAt: datetime("unlocked_at").notNull().default(now),
}, (t) => [
  uniqueIndex("uq_uhi_user_island").on(t.userId, t.islandId),
]);

/**
 * Production state of a placed producing building (`homes.json` > buildables > production), keyed by the placement's
 * `instanceId` (the template instance id for island default objects). No row = `since_unix` 0 and no stationed units.
 */
export const userHomeProduction = mysqlTable("user_home_production", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  instanceId: varchar("instance_id", { length: 80 }).notNull(),
  islandId: varchar("island_id", { length: 64 }).notNull(),
  buildableId: varchar("buildable_id", { length: 64 }).notNull(),
  /** Accrual anchor (unix seconds). */
  sinceUnix: bigint("since_unix", { mode: "number" }).notNull().default(0),
  /** Roster uids stationed in the building (unit EXP producers); JSON array of strings. */
  unitsJson: json("units_json"),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.instanceId] }),
]);

/**
 * Buildings the player owns but has not placed yet (shop grants). `placeObject` consumes one unit
 * instead of charging the build cost.
 */
export const userBuildingInventory = mysqlTable("user_building_inventory", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  buildableId: varchar("buildable_id", { length: 64 }).notNull(),
  /** Unplaced units (unsigned: can never go below zero). */
  count: int("count", { unsigned: true }).notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  uniqueIndex("uq_ubi_user_buildable").on(t.userId, t.buildableId),
]);

export const chatMessages = mysqlTable("chat_messages", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  channel: int("channel").notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  nickname: varchar("nickname", { length: 32 }).notNull(),
  message: varchar("message", { length: 300 }).notNull(),
  /** Unmasked text; only set when the chat word filter masked the line (`message` holds the masked one). */
  originalMessage: varchar("original_message", { length: 300 }),
  /** Sender's profile icon at send time (null on rows written before migration 0004 -> client default avatar). */
  iconId: varchar("icon_id", { length: 64 }),
  /** Sender's account level at send time. */
  level: int("level").notNull().default(1),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_chat_channel_time").on(t.channel, t.id),
]);

/** Purchase counters per item and limit window (`D:2026-10-05`, `W:2026-10-05`, `M:2026-10`, `U`). */
export const userShopCounters = mysqlTable("user_shop_counters", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  itemId: varchar("item_id", { length: 64 }).notNull(),
  windowKey: varchar("window_key", { length: 32 }).notNull(),
  count: int("count").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.itemId, t.windowKey] }),
]);

/** Summons made per scroll (tutorial guaranteed summons: the first N summons give fixed monsters). */
export const userSummonCounters = mysqlTable("user_summon_counters", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  scrollId: varchar("scroll_id", { length: 64 }).notNull(),
  summons: int("summons").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.scrollId] }),
]);

/** Append-only purchase log (support / audit). */
export const userShopPurchases = mysqlTable("user_shop_purchases", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  itemId: varchar("item_id", { length: 64 }).notNull(),
  windowKey: varchar("window_key", { length: 32 }).notNull(),
  currencyId: varchar("currency_id", { length: 64 }),
  price: int("price").notNull().default(0),
  firstPurchase: tinyint("first_purchase").notNull().default(0),
  grants: json("grants"),
  /** Client idempotency key of the purchase (unique per user). */
  purchaseId: varchar("purchase_id", { length: 64 }),
  /** Response sent to the client, replayed when the same purchaseId is retried. */
  response: json("response"),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_usp_user_time").on(t.userId, t.createdAt),
  uniqueIndex("uq_usp_user_purchase").on(t.userId, t.purchaseId),
]);

/**
 * Store transactions already delivered (real-money purchases): one row per Google purchase token / Apple transaction /
 * demo id, so a receipt is never granted twice, on any account. No foreign key on purpose: the rows outlive a deleted
 * account (an Apple signed transaction stays valid forever and could be replayed on a new account).
 */
export const userIapTransactions = mysqlTable("user_iap_transactions", {
  /** SHA-256 hex of `<store>:<transaction id>`. */
  transactionKey: char("transaction_key", { length: 64 }).primaryKey().notNull(),
  store: varchar("store", { length: 32 }).notNull(),
  userId: char("user_id", { length: 36 }).notNull(),
  itemId: varchar("item_id", { length: 64 }).notNull(),
  productId: varchar("product_id", { length: 255 }).notNull(),
  /** `user_shop_purchases.purchase_id` of the delivery (its response is replayed when the receipt comes back). */
  purchaseId: varchar("purchase_id", { length: 64 }).notNull(),
  /** Google order id / Apple transaction id (support). */
  orderId: varchar("order_id", { length: 255 }),
  /** Production, Sandbox, Test or Demo. */
  environment: varchar("environment", { length: 16 }).notNull(),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_uiap_user_time").on(t.userId, t.createdAt),
]);
