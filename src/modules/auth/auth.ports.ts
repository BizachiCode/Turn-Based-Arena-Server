import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type UserCredentialsRow = {
  id: string;
  username: string;
  passwordHash: string;
  failedLogins: number;
  lockedUntil: Date | null;
  isBanned: boolean;
  banReason: string | null;
  banExpiresAt: Date | null;
  isGuest: boolean;
  deletionScheduledAt: Date | null;
};

/** Full account row (account room, `account` object of auth responses). */
export type AccountRow = UserCredentialsRow & {
  email: string;
  createdAt: Date;
  deletionRequestedAt: Date | null;
  passwordChangedAt: Date | null;
};

export type RefreshLookupRow = {
  username: string;
  isBanned: boolean;
  banReason: string | null;
  banExpiresAt: Date | null;
  deletionScheduledAt: Date | null;
  /** The token row matched the hash but was revoked (logout, password change, deletion request). */
  isRevoked: boolean;
};

export type RefreshTokenRecord = {
  userId: string;
  deviceId: string;
  tokenHash: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
};

export type AuditKind =
  | "REGISTER"
  | "LOGIN"
  | "LOGOUT"
  | "REFRESH"
  | "PASSWORD_CHANGE"
  | "BAN"
  | "UNBAN"
  | "LINK_EMAIL"
  | "LOGOUT_OTHERS"
  | "DELETION_REQUESTED"
  | "DELETION_CANCELLED"
  | "ACCOUNT_PURGED";

/** Persistence port for accounts, refresh tokens and the audit trail. */
export interface AuthRepository {
  findByEmailOrUsername(emailOrUsername: string, session?: DbSession, forUpdate?: boolean): Promise<UserCredentialsRow | null>;
  existsByEmailOrUsername(email: string, username: string, session?: DbSession): Promise<boolean>;
  insertUser(userId: string, email: string, username: string, passwordHash: string, isGuest: boolean, session: DbSession): Promise<void>;
  /** Account by id (`forUpdate` locks the row inside the session's transaction). */
  getAccountById(userId: string, session?: DbSession, forUpdate?: boolean): Promise<AccountRow | null>;
  /** Replaces email + password hash + guest flag (guest → registered); stamps password_changed_at. */
  updateCredentials(userId: string, email: string, passwordHash: string, isGuest: boolean, changedAt: Date, session: DbSession): Promise<void>;
  /** Replaces the password hash and stamps password_changed_at. */
  updatePasswordHash(userId: string, passwordHash: string, changedAt: Date, session: DbSession): Promise<void>;
  /** Sets (both dates) or clears (both null) the deletion schedule. */
  setDeletionSchedule(userId: string, requestedAt: Date | null, scheduledAt: Date | null, session: DbSession): Promise<void>;
  /** Ids of accounts whose deletion_scheduled_at <= now (locked when a session is given). */
  findUsersDueForDeletion(now: Date, limit: number, session?: DbSession): Promise<string[]>;
  /** Hard-deletes the users (player data goes through FK cascades) and their refresh-token log rows. */
  deleteUsers(userIds: string[], session: DbSession): Promise<number>;
  getUsername(userId: string, session?: DbSession): Promise<string | null>;
  setFailedLogins(userId: string, failedLogins: number, lockedUntil: Date | null, session?: DbSession): Promise<void>;
  markLoginSuccess(userId: string, session?: DbSession): Promise<void>;
  setBan(userId: string, banned: boolean, reason: string | null, until: Date | null, session?: DbSession): Promise<void>;

  /** Upserts the device's refresh token and logs the issue. */
  saveRefreshToken(record: RefreshTokenRecord, action: "ISSUE" | "REFRESH", session: DbSession): Promise<void>;
  /** Unexpired token row matching (user, device, hash), revoked or not; locked when a session is given. */
  findRefreshToken(userId: string, deviceId: string, tokenHash: string, session?: DbSession): Promise<RefreshLookupRow | null>;
  /** Revokes the (user, device, hash) token; false (and nothing written) when no such token exists. */
  revokeRefreshToken(userId: string, deviceId: string, tokenHash: string, session?: DbSession): Promise<boolean>;
  /** Revokes every active refresh token of the user except `keepDeviceId` (logged as REVOKE); returns the device ids. */
  revokeRefreshTokensExcept(userId: string, keepDeviceId: string, session: DbSession): Promise<string[]>;
  /** Revokes every active refresh token of the user (logged as REVOKE); returns the device ids. */
  revokeAllRefreshTokens(userId: string, session: DbSession): Promise<string[]>;
  deleteExpiredRefreshTokens(retentionDays: number): Promise<number>;

  audit(userId: string | null, kind: AuditKind, meta: Record<string, unknown> | null, session?: DbSession): Promise<void>;
}
