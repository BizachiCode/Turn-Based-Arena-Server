// Accounts: users, profiles, refresh tokens, audit trail, presence sessions.
import { mysqlTable, char, varchar, tinyint, int, bigint, datetime, json, uniqueIndex, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const users = mysqlTable("users", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  username: varchar("username", { length: 32 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  isVerified: tinyint("is_verified").notNull().default(0),
  failedLogins: int("failed_logins").notNull().default(0),
  lockedUntil: datetime("locked_until"),
  isBanned: tinyint("is_banned").notNull().default(0),
  banReason: varchar("ban_reason", { length: 255 }),
  banExpiresAt: datetime("ban_expires_at"),
  /** GM chat mute: the player cannot post in any chat channel until then (null = not muted). */
  chatMutedUntil: datetime("chat_muted_until"),
  chatMuteReason: varchar("chat_mute_reason", { length: 255 }),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
  lastLoginAt: datetime("last_login_at"),
  /** 1 for guest accounts (email `guest+<id>@local`, random password) until an email is linked. */
  isGuest: tinyint("is_guest").notNull().default(0),
  /** When the player asked to delete the account (null = not pending). */
  deletionRequestedAt: datetime("deletion_requested_at"),
  /** When the purge job hard-deletes the account (requested + ACCOUNT_DELETION_GRACE_DAYS). */
  deletionScheduledAt: datetime("deletion_scheduled_at"),
  passwordChangedAt: datetime("password_changed_at"),
}, (t) => [
  uniqueIndex("uq_users_email").on(t.email),
  uniqueIndex("uq_users_username").on(t.username),
  index("idx_users_last_login").on(t.lastLoginAt),
  index("idx_users_ban").on(t.isBanned, t.banExpiresAt),
  index("idx_users_deletion_scheduled").on(t.deletionScheduledAt),
]);

export const userProfile = mysqlTable("user_profile", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 32 }).notNull(),
  iconId: varchar("icon_id", { length: 64 }).notNull(),
  /** Unused: guild membership lives in `guild_members` (column kept for existing databases). */
  guildId: char("guild_id", { length: 36 }),
  level: int("level").notNull().default(1),
  currentExp: bigint("current_exp", { mode: "number" }).notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  uniqueIndex("uq_profile_name").on(t.name),
  index("idx_profile_guild").on(t.guildId),
  /** Level ranking (top list + "players ahead of me"). */
  index("idx_profile_level").on(t.level, t.currentExp),
]);

export const userRefreshTokens = mysqlTable("user_refresh_tokens", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceId: varchar("device_id", { length: 64 }).notNull(),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  issuedAt: datetime("issued_at").notNull().default(now),
  lastUsedAt: datetime("last_used_at").notNull().default(now),
  expiresAt: datetime("expires_at").notNull(),
  isRevoked: tinyint("is_revoked").notNull().default(0),
  ip: varchar("ip", { length: 45 }),
  userAgent: varchar("user_agent", { length: 255 }),
}, (t) => [
  uniqueIndex("uq_urt_user_device").on(t.userId, t.deviceId),
  index("idx_urt_expiry").on(t.expiresAt),
  index("idx_urt_refresh_lookup").on(t.userId, t.deviceId, t.tokenHash),
]);

export const userRefreshTokenLog = mysqlTable("user_refresh_token_log", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull(),
  deviceId: varchar("device_id", { length: 64 }).notNull(),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  /** ISSUE | REFRESH | REVOKE | EXPIRE */
  action: varchar("action", { length: 16 }).notNull(),
  at: datetime("at").notNull().default(now),
  ip: varchar("ip", { length: 45 }),
  userAgent: varchar("user_agent", { length: 255 }),
}, (t) => [
  index("idx_urtl_user").on(t.userId),
  index("idx_urtl_at").on(t.at),
]);

export const auditEvents = mysqlTable("audit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
  /** REGISTER | LOGIN | LOGOUT | REFRESH | PASSWORD_CHANGE | BAN | UNBAN | LINK_EMAIL | LOGOUT_OTHERS | DELETION_* | ACCOUNT_PURGED | ... */
  kind: varchar("kind", { length: 32 }).notNull(),
  meta: json("meta"),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_audit_user").on(t.userId),
  index("idx_audit_created").on(t.createdAt),
]);

export const userSessions = mysqlTable("user_sessions", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  sessionId: varchar("session_id", { length: 64 }).notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceId: varchar("device_id", { length: 64 }).notNull(),
  room: varchar("room", { length: 64 }).notNull(),
  connectedAt: datetime("connected_at").notNull().default(now),
  lastHeartbeatAt: datetime("last_heartbeat_at").notNull().default(now),
  disconnectedAt: datetime("disconnected_at"),
  ip: varchar("ip", { length: 45 }),
  userAgent: varchar("user_agent", { length: 255 }),
}, (t) => [
  uniqueIndex("uq_session").on(t.sessionId),
  index("idx_user_active").on(t.userId, t.disconnectedAt),
  index("idx_online").on(t.lastHeartbeatAt, t.disconnectedAt),
]);
