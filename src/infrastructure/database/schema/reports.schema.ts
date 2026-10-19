// Player reports (GM panel "Reports"). Chat evidence is copied from the server's stored history when the report is
// filed, so it survives the chat history cap and never depends on text sent by the client.
import { mysqlTable, bigint, char, varchar, tinyint, json, datetime, index, uniqueIndex } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;

export const playerReports = mysqlTable("player_reports", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  /** Null once the reporter's account was purged (the report stays for the moderators). */
  reporterUserId: char("reporter_user_id", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
  targetUserId: char("target_user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Target's display name when the report was filed. */
  targetName: varchar("target_name", { length: 64 }).notNull().default(""),
  /** spam | offensive | cheating | name | other */
  category: varchar("category", { length: 16 }).notNull(),
  comment: varchar("comment", { length: 300 }).notNull().default(""),
  /** global_chat | guild_chat | profile | arena | other */
  source: varchar("source", { length: 16 }).notNull(),
  /** Global channel number or guild id of the reported line (chat sources only). */
  sourceRef: varchar("source_ref", { length: 36 }),
  /** `chat_messages.id` / `guild_chat_messages.id` of the reported line, with a server-side copy of its text. */
  messageId: bigint("message_id", { mode: "number" }),
  messageText: varchar("message_text", { length: 300 }),
  /** JSON array: the target's newest stored chat lines when the report was filed (copied from the server history). */
  contextJson: json("context_json"),
  /** open | resolved | dismissed */
  status: varchar("status", { length: 12 }).notNull().default("open"),
  /** 1 while open, NULL afterwards: the unique index below allows one open report per reporter -> target pair. */
  openSlot: tinyint("open_slot"),
  /** none | warn | mute | kick | ban (resolved reports) */
  resolutionAction: varchar("resolution_action", { length: 16 }),
  resolutionNote: varchar("resolution_note", { length: 255 }),
  handledAt: datetime("handled_at"),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_reports_status").on(t.status, t.id),
  index("idx_reports_target").on(t.targetUserId, t.status),
  index("idx_reports_reporter").on(t.reporterUserId, t.createdAt),
  uniqueIndex("uq_reports_open_pair").on(t.reporterUserId, t.targetUserId, t.openSlot),
]);
