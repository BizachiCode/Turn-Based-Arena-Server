// Mailbox: one row per mail of a player, delivery receipts (idempotent sends) and broadcasts to every player.
import { mysqlTable, char, varchar, text, tinyint, datetime, primaryKey, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;

/** A mail in a player's inbox. Rewards (`attachments_json`, a shop payload) are granted once (`claimed_at`). */
export const userMail = mysqlTable("user_mail", {
  id: char("id", { length: 16 }).primaryKey().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** system | guild | reward | gm */
  category: varchar("category", { length: 16 }).notNull().default("system"),
  sender: varchar("sender", { length: 64 }).notNull().default(""),
  title: varchar("title", { length: 120 }).notNull().default(""),
  body: text("body"),
  /** Translation keys of system mails (the client falls back to the literal texts). */
  titleKey: varchar("title_key", { length: 64 }),
  bodyKey: varchar("body_key", { length: 64 }),
  /** JSON array of strings substituted into the translated texts ({0}, {1}...). */
  paramsJson: text("params_json"),
  attachmentsJson: text("attachments_json"),
  createdAt: datetime("created_at").notNull().default(now),
  expiresAt: datetime("expires_at"),
  readAt: datetime("read_at"),
  claimedAt: datetime("claimed_at"),
}, (t) => [
  index("idx_user_mail_user_created").on(t.userId, t.createdAt),
]);

/** Deliveries already made with a dedupe key (welcome mail, broadcasts...): survives the mail's deletion. */
export const userMailReceipts = mysqlTable("user_mail_receipts", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  receiptKey: varchar("receipt_key", { length: 96 }).notNull(),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  primaryKey({ columns: [t.userId, t.receiptKey] }),
]);

/** Mail sent to every player (GM panel). Copied into each inbox the next time the player opens it. */
export const mailBroadcasts = mysqlTable("mail_broadcasts", {
  id: char("id", { length: 16 }).primaryKey().notNull(),
  category: varchar("category", { length: 16 }).notNull().default("gm"),
  sender: varchar("sender", { length: 64 }).notNull().default(""),
  title: varchar("title", { length: 120 }).notNull().default(""),
  body: text("body"),
  titleKey: varchar("title_key", { length: 64 }),
  bodyKey: varchar("body_key", { length: 64 }),
  paramsJson: text("params_json"),
  attachmentsJson: text("attachments_json"),
  /** 0 = only accounts that existed when it was sent; 1 = accounts created later too (until it expires). */
  includeNewPlayers: tinyint("include_new_players").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
  expiresAt: datetime("expires_at"),
}, (t) => [
  index("idx_mail_broadcast_created").on(t.createdAt),
]);
