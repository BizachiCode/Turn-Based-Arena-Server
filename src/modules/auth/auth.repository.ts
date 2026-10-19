import { and, asc, eq, gt, inArray, isNotNull, lt, lte, ne, or } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { auditEvents, userRefreshTokenLog, userRefreshTokens, users } from "../../infrastructure/database/schema/index.js";
import type { AccountRow, AuditKind, AuthRepository, RefreshLookupRow, RefreshTokenRecord, UserCredentialsRow } from "./auth.ports.js";

const credentialColumns = {
  id: users.id,
  username: users.username,
  passwordHash: users.passwordHash,
  failedLogins: users.failedLogins,
  lockedUntil: users.lockedUntil,
  isBanned: users.isBanned,
  banReason: users.banReason,
  banExpiresAt: users.banExpiresAt,
  isGuest: users.isGuest,
  deletionScheduledAt: users.deletionScheduledAt,
};

/** Drizzle implementation of {@link AuthRepository}. */
export class DrizzleAuthRepository extends DrizzleRepository implements AuthRepository {
  constructor(database: Database) {
    super(database);
  }

  async findByEmailOrUsername(emailOrUsername: string, session?: DbSession, forUpdate = false): Promise<UserCredentialsRow | null> {
    const query = this.db(session)
      .select(credentialColumns)
      .from(users)
      .where(or(eq(users.email, emailOrUsername), eq(users.username, emailOrUsername)))
      .limit(1);
    const [row] = session && forUpdate ? await query.for("update") : await query;
    return row ? { ...row, isBanned: row.isBanned === 1, isGuest: row.isGuest === 1 } : null;
  }

  async getAccountById(userId: string, session?: DbSession, forUpdate = false): Promise<AccountRow | null> {
    const query = this.db(session)
      .select({
        ...credentialColumns,
        email: users.email,
        createdAt: users.createdAt,
        deletionRequestedAt: users.deletionRequestedAt,
        passwordChangedAt: users.passwordChangedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const [row] = session && forUpdate ? await query.for("update") : await query;
    return row ? { ...row, isBanned: row.isBanned === 1, isGuest: row.isGuest === 1 } : null;
  }

  async updateCredentials(userId: string, email: string, passwordHash: string, isGuest: boolean, changedAt: Date, session: DbSession): Promise<void> {
    await this.db(session).update(users)
      .set({ email, passwordHash, isGuest: isGuest ? 1 : 0, passwordChangedAt: changedAt })
      .where(eq(users.id, userId));
  }

  async updatePasswordHash(userId: string, passwordHash: string, changedAt: Date, session: DbSession): Promise<void> {
    await this.db(session).update(users).set({ passwordHash, passwordChangedAt: changedAt }).where(eq(users.id, userId));
  }

  async setDeletionSchedule(userId: string, requestedAt: Date | null, scheduledAt: Date | null, session: DbSession): Promise<void> {
    await this.db(session).update(users)
      .set({ deletionRequestedAt: requestedAt, deletionScheduledAt: scheduledAt })
      .where(eq(users.id, userId));
  }

  async findUsersDueForDeletion(now: Date, limit: number, session?: DbSession): Promise<string[]> {
    const query = this.db(session)
      .select({ id: users.id })
      .from(users)
      .where(and(isNotNull(users.deletionScheduledAt), lte(users.deletionScheduledAt, now)))
      .orderBy(asc(users.deletionScheduledAt))
      .limit(Math.max(1, limit));
    const rows = session ? await query.for("update") : await query;
    return rows.map((row) => row.id);
  }

  async deleteUsers(userIds: string[], session: DbSession): Promise<number> {
    if (userIds.length === 0) return 0;
    const db = this.db(session);
    // The refresh-token log has no FK (it outlives token rows), so it is cleaned explicitly.
    await db.delete(userRefreshTokenLog).where(inArray(userRefreshTokenLog.userId, userIds));
    return affectedRows(await db.delete(users).where(inArray(users.id, userIds)));
  }

  async existsByEmailOrUsername(email: string, username: string, session?: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ id: users.id }).from(users)
      .where(or(eq(users.email, email), eq(users.username, username))).limit(1);
    return !!row;
  }

  async insertUser(userId: string, email: string, username: string, passwordHash: string, isGuest: boolean, session: DbSession): Promise<void> {
    await this.db(session).insert(users).values({ id: userId, email, username, passwordHash, isVerified: 0, isGuest: isGuest ? 1 : 0 });
  }

  async getUsername(userId: string, session?: DbSession): Promise<string | null> {
    const [row] = await this.db(session).select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.username ?? null;
  }

  async setFailedLogins(userId: string, failedLogins: number, lockedUntil: Date | null, session?: DbSession): Promise<void> {
    await this.db(session).update(users).set({ failedLogins, lockedUntil }).where(eq(users.id, userId));
  }

  async markLoginSuccess(userId: string, session?: DbSession): Promise<void> {
    await this.db(session).update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, userId));
  }

  async setBan(userId: string, banned: boolean, reason: string | null, until: Date | null, session?: DbSession): Promise<void> {
    await this.db(session).update(users)
      .set({ isBanned: banned ? 1 : 0, banReason: banned ? reason : null, banExpiresAt: banned ? until : null })
      .where(eq(users.id, userId));
  }

  async saveRefreshToken(record: RefreshTokenRecord, action: "ISSUE" | "REFRESH", session: DbSession): Promise<void> {
    const db = this.db(session);
    const now = new Date();
    await db.insert(userRefreshTokens)
      .values({
        userId: record.userId,
        deviceId: record.deviceId,
        tokenHash: record.tokenHash,
        issuedAt: now,
        lastUsedAt: now,
        expiresAt: record.expiresAt,
        isRevoked: 0,
        ip: record.ip ?? null,
        userAgent: record.userAgent ?? null,
      })
      .onDuplicateKeyUpdate({
        set: {
          tokenHash: record.tokenHash,
          issuedAt: now,
          lastUsedAt: now,
          expiresAt: record.expiresAt,
          isRevoked: 0,
          ip: record.ip ?? null,
          userAgent: record.userAgent ?? null,
        },
      });

    await db.insert(userRefreshTokenLog).values({
      userId: record.userId,
      deviceId: record.deviceId,
      tokenHash: record.tokenHash,
      action,
      ip: record.ip ?? null,
      userAgent: record.userAgent ?? null,
    });
  }

  async findRefreshToken(userId: string, deviceId: string, tokenHash: string, session?: DbSession): Promise<RefreshLookupRow | null> {
    const query = this.db(session)
      .select({
        username: users.username,
        isBanned: users.isBanned,
        banReason: users.banReason,
        banExpiresAt: users.banExpiresAt,
        deletionScheduledAt: users.deletionScheduledAt,
        isRevoked: userRefreshTokens.isRevoked,
      })
      .from(userRefreshTokens)
      .innerJoin(users, eq(users.id, userRefreshTokens.userId))
      .where(and(
        eq(userRefreshTokens.userId, userId),
        eq(userRefreshTokens.deviceId, deviceId),
        eq(userRefreshTokens.tokenHash, tokenHash),
        gt(userRefreshTokens.expiresAt, new Date()),
      ))
      .limit(1);
    // Locks the token row so two concurrent refreshes with the same token can't both rotate it.
    const [row] = session ? await query.for("update") : await query;
    return row ? { ...row, isBanned: row.isBanned === 1, isRevoked: row.isRevoked === 1 } : null;
  }

  async revokeRefreshToken(userId: string, deviceId: string, tokenHash: string, session?: DbSession): Promise<boolean> {
    const db = this.db(session);
    const match = and(
      eq(userRefreshTokens.userId, userId),
      eq(userRefreshTokens.deviceId, deviceId),
      eq(userRefreshTokens.tokenHash, tokenHash),
    );
    // Nothing matches (wrong token / unknown user): no write at all, so a forged logout leaves no trace in the token log.
    const [row] = await db.select({ id: userRefreshTokens.id }).from(userRefreshTokens).where(match).limit(1);
    if (!row) return false;
    await db.update(userRefreshTokens).set({ isRevoked: 1 }).where(match);
    await db.insert(userRefreshTokenLog).values({ userId, deviceId, tokenHash, action: "REVOKE" });
    return true;
  }

  async revokeRefreshTokensExcept(userId: string, keepDeviceId: string, session: DbSession): Promise<string[]> {
    return this.revokeActiveTokens(userId, keepDeviceId, session);
  }

  async revokeAllRefreshTokens(userId: string, session: DbSession): Promise<string[]> {
    return this.revokeActiveTokens(userId, null, session);
  }

  private async revokeActiveTokens(userId: string, keepDeviceId: string | null, session: DbSession): Promise<string[]> {
    const db = this.db(session);
    const active = await db
      .select({ id: userRefreshTokens.id, deviceId: userRefreshTokens.deviceId, tokenHash: userRefreshTokens.tokenHash })
      .from(userRefreshTokens)
      .where(and(
        eq(userRefreshTokens.userId, userId),
        eq(userRefreshTokens.isRevoked, 0),
        keepDeviceId === null ? undefined : ne(userRefreshTokens.deviceId, keepDeviceId),
      ))
      .for("update");
    if (active.length === 0) return [];

    await db.update(userRefreshTokens).set({ isRevoked: 1 }).where(inArray(userRefreshTokens.id, active.map((row) => row.id)));
    await db.insert(userRefreshTokenLog).values(active.map((row) => ({ userId, deviceId: row.deviceId, tokenHash: row.tokenHash, action: "REVOKE" })));
    return active.map((row) => row.deviceId);
  }

  async deleteExpiredRefreshTokens(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000);
    const result = await this.database.delete(userRefreshTokens).where(and(
      or(eq(userRefreshTokens.isRevoked, 1), lt(userRefreshTokens.expiresAt, new Date())),
      lt(userRefreshTokens.issuedAt, cutoff),
    ));
    return affectedRows(result);
  }

  async audit(userId: string | null, kind: AuditKind, meta: Record<string, unknown> | null, session?: DbSession): Promise<void> {
    await this.db(session).insert(auditEvents).values({ userId, kind, meta });
  }
}

