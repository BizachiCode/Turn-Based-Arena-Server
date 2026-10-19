// Social layer: friendships (requests and accepted pairs), blocks, private messages (one thread row per player and
// peer: last line, unread count) and real-time friendly battles (challenge + match in one row).
import { mysqlTable, bigint, char, varchar, int, datetime, json, mysqlEnum, primaryKey, uniqueIndex, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;

/**
 * One row per pair of players (`pair_key` = lower id + ":" + higher id): a pending request from `requester_id` to
 * `addressee_id`, or an accepted friendship. Rejected / cancelled requests and removed friends are deleted.
 */
export const friendships = mysqlTable("friendships", {
  id: char("id", { length: 26 }).primaryKey().notNull(),
  pairKey: varchar("pair_key", { length: 73 }).notNull(),
  requesterId: char("requester_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  addresseeId: char("addressee_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  status: mysqlEnum("status", ["pending", "accepted"]).notNull().default("pending"),
  createdAt: datetime("created_at").notNull().default(now),
  respondedAt: datetime("responded_at"),
}, (t) => [
  uniqueIndex("uq_friend_pair").on(t.pairKey),
  index("idx_friend_requester").on(t.requesterId, t.status),
  index("idx_friend_addressee").on(t.addresseeId, t.status),
]);

/** `blocker_id` blocked `blocked_id`: no friend requests, private messages or challenges between them. */
export const userBlocks = mysqlTable("user_blocks", {
  blockerId: char("blocker_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  blockedId: char("blocked_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  primaryKey({ columns: [t.blockerId, t.blockedId] }),
  index("idx_block_blocked").on(t.blockedId),
]);

/** Private message lines (`conversation_key` = lower id + ":" + higher id), trimmed to the newest N per conversation. */
export const directMessages = mysqlTable("direct_messages", {
  id: bigint("id", { mode: "number", unsigned: true }).primaryKey().autoincrement().notNull(),
  conversationKey: varchar("conversation_key", { length: 73 }).notNull(),
  senderId: char("sender_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  recipientId: char("recipient_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  message: varchar("message", { length: 300 }).notNull(),
  /** Unmasked text; only set when the word filter masked the line. */
  originalMessage: varchar("original_message", { length: 300 }),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_dm_conversation").on(t.conversationKey, t.id),
]);

/** One row per player and peer they exchanged messages with: the conversation list and its unread counts. */
export const dmThreads = mysqlTable("dm_threads", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  peerId: char("peer_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  lastMessageId: bigint("last_message_id", { mode: "number", unsigned: true }).notNull().default(0),
  lastAt: datetime("last_at").notNull().default(now),
  /** Lines from the peer newer than `last_read_id`. */
  unread: int("unread").notNull().default(0),
  lastReadId: bigint("last_read_id", { mode: "number", unsigned: true }).notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.userId, t.peerId] }),
  index("idx_dm_thread_recent").on(t.userId, t.lastAt),
]);

/**
 * A friendly battle: the challenge (pending -> accepted / declined / cancelled / expired) and, once accepted, the match
 * (room id, then finished with a winner or aborted). No rewards, no rating.
 */
export const friendlyMatches = mysqlTable("friendly_matches", {
  id: char("id", { length: 26 }).primaryKey().notNull(),
  challengerId: char("challenger_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  targetId: char("target_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  status: mysqlEnum("status", ["pending", "accepted", "declined", "cancelled", "expired", "finished", "aborted"]).notNull().default("pending"),
  roomId: varchar("room_id", { length: 64 }),
  winnerId: char("winner_id", { length: 36 }),
  finishedReason: varchar("finished_reason", { length: 32 }),
  resultJson: json("result_json"),
  createdAt: datetime("created_at").notNull().default(now),
  expiresAt: datetime("expires_at").notNull(),
  respondedAt: datetime("responded_at"),
  finishedAt: datetime("finished_at"),
}, (t) => [
  index("idx_fm_challenger").on(t.challengerId, t.status),
  index("idx_fm_target").on(t.targetId, t.status),
]);
