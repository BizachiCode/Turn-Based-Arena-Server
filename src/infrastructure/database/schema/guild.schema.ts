// Guilds: one row per guild, its members (one guild per player), pending join requests, the guild quests
// (members' daily quest progress, weekly activity points and claimed weekly chests) and the guild chat history.
import { mysqlTable, bigint, char, varchar, int, text, datetime, mysqlEnum, primaryKey, uniqueIndex, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const guilds = mysqlTable("guilds", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  name: varchar("name", { length: 32 }).notNull(),
  /** Lowercased name: case-insensitive uniqueness that does not depend on the table collation. */
  nameKey: varchar("name_key", { length: 32 }).notNull(),
  /** Public text shown in the guild list. */
  description: varchar("description", { length: 255 }).notNull().default(""),
  /** Members-only announcement. */
  notice: varchar("notice", { length: 255 }).notNull().default(""),
  iconId: varchar("icon_id", { length: 64 }).notNull(),
  /** JSON array of tag ids from `guild.json`. */
  tagsJson: text("tags_json"),
  joinType: mysqlEnum("join_type", ["open", "approval"]).notNull().default("open"),
  /** Account level required to join. */
  minLevel: int("min_level").notNull().default(1),
  /** Kept in sync by the guild service under the guild row lock (list sorting, "full" checks). */
  memberCount: int("member_count").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  uniqueIndex("uq_guild_name_key").on(t.nameKey),
  index("idx_guild_member_count").on(t.memberCount),
]);

/** One row per player in a guild (the primary key makes a second membership impossible). */
export const guildMembers = mysqlTable("guild_members", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  guildId: char("guild_id", { length: 36 }).notNull().references(() => guilds.id, { onDelete: "cascade" }),
  /** Random public handle sent to other players (kick/promote targets); internal user ids are never exposed. */
  publicId: char("public_id", { length: 16 }).notNull(),
  role: mysqlEnum("role", ["leader", "officer", "member"]).notNull().default("member"),
  joinedAt: datetime("joined_at").notNull().default(now),
}, (t) => [
  uniqueIndex("uq_guild_member_public_id").on(t.publicId),
  index("idx_guild_member_guild").on(t.guildId, t.role),
]);

/** Applications to guilds that require approval. Removed when accepted/rejected/cancelled or the player joins any guild. */
export const guildJoinRequests = mysqlTable("guild_join_requests", {
  id: char("id", { length: 16 }).primaryKey().notNull(),
  guildId: char("guild_id", { length: 36 }).notNull().references(() => guilds.id, { onDelete: "cascade" }),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  uniqueIndex("uq_guild_request_guild_user").on(t.guildId, t.userId),
  index("idx_guild_request_user").on(t.userId, t.createdAt),
]);

/** Daily guild quest progress of a player (one row per quest and day, `period_key` = `D:2026-10-11`). */
export const guildQuestProgress = mysqlTable("guild_quest_progress", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  questId: varchar("quest_id", { length: 64 }).notNull(),
  periodKey: varchar("period_key", { length: 16 }).notNull(),
  progress: int("progress").notNull().default(0),
  claimedAt: datetime("claimed_at"),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.questId, t.periodKey] }),
  index("idx_guild_quest_user_period").on(t.userId, t.periodKey),
]);

/** Points a member brought to the guild in a week (`week_key` = `W:<week start date>`); the guild total is their sum. */
export const guildActivity = mysqlTable("guild_activity", {
  guildId: char("guild_id", { length: 36 }).notNull().references(() => guilds.id, { onDelete: "cascade" }),
  weekKey: varchar("week_key", { length: 16 }).notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  points: int("points").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.guildId, t.weekKey, t.userId] }),
]);

/** Weekly chests a player claimed (per player, not per guild: changing guilds never allows a second claim). */
export const guildChestClaims = mysqlTable("guild_chest_claims", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  weekKey: varchar("week_key", { length: 16 }).notNull(),
  chestId: varchar("chest_id", { length: 64 }).notNull(),
  guildId: char("guild_id", { length: 36 }).notNull(),
  claimedAt: datetime("claimed_at").notNull().default(now),
}, (t) => [
  primaryKey({ columns: [t.userId, t.weekKey, t.chestId] }),
]);

/**
 * Guild chat history (newest messages per guild, trimmed by the chat service). Deleted with the guild; a purged
 * account takes its own messages along. System lines (`kind = system`) have no sender: `nickname` is the player the
 * line is about and `message` the event key (`created`, `joined`, `left`, `kicked`, `promoted`, `demoted`, `leader`).
 */
export const guildChatMessages = mysqlTable("guild_chat_messages", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  guildId: char("guild_id", { length: 36 }).notNull().references(() => guilds.id, { onDelete: "cascade" }),
  userId: char("user_id", { length: 36 }).references(() => users.id, { onDelete: "cascade" }),
  kind: mysqlEnum("kind", ["user", "system"]).notNull().default("user"),
  nickname: varchar("nickname", { length: 32 }).notNull(),
  iconId: varchar("icon_id", { length: 64 }),
  level: int("level").notNull().default(1),
  message: varchar("message", { length: 300 }).notNull(),
  /** Unmasked text; only set when the chat word filter masked the line (`message` holds the masked one). */
  originalMessage: varchar("original_message", { length: 300 }),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_guild_chat_guild").on(t.guildId, t.id),
]);
