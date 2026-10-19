// Account management for logged-in players: info, guest → email upgrade, password change, device logout,
// deletion request; plus the hard delete of accounts whose grace period is over (purge job).

import crypto from "node:crypto";

import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { PasswordHasher } from "../../shared/security/password-hasher.js";
import type { SessionStore } from "../../shared/security/session-store.js";
import { notifyUserRevoked } from "../../shared/rooms/user-revocation.js";
import { toAccountDto } from "../auth/auth.mapper.js";
import type { AuthRepository } from "../auth/auth.ports.js";
import { committedFailure, PasswordGuard, runCommitted } from "../auth/password-guard.js";
import type { AccountDto, DeletionRequestResultDto, RevokedDevicesResultDto } from "./account.dto.js";

const DAY_MS = 86_400_000;
const logger = createLogger("AccountService");

export type AccountServiceOptions = {
  /** Days between the deletion request and the hard delete (0 = right away). */
  deletionGraceDays: number;
  /** Accounts hard-deleted per purge transaction. */
  purgeBatchSize?: number;
  /**
   * Called after the sessions of a user were deleted, so live connections of the revoked sessions are closed
   * (default: publishes the "user revoked" event the rooms listen to).
   */
  onSessionsRevoked?: (userId: string) => void;
};

/** Result of a deletion request: the response plus the revocation that must run after the reply is sent. */
export type DeletionRequestOutcome = DeletionRequestResultDto & {
  /** Deletes every session of the user (kicks the caller too) and, with a 0-day grace, purges right away. */
  afterResponse: () => Promise<void>;
};

/**
 * Runs inside the purge transaction right before the accounts are deleted, for data the FK cascades alone would leave
 * inconsistent (e.g. a guild losing its leader).
 */
export type PurgeHook = (userIds: string[], session: DbSession) => Promise<void>;

/** SHA-256 of a user id: lets operators correlate a purge with a known id without storing the id itself. */
export function purgedUserIdHash(userId: string): string {
  return crypto.createHash("sha256").update(userId, "utf8").digest("hex");
}

export class AccountService {
  private readonly guard: PasswordGuard;
  private readonly purgeHooks: PurgeHook[] = [];

  constructor(
    private readonly users: AuthRepository,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionStore,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly options: AccountServiceOptions,
  ) {
    this.guard = new PasswordGuard(users, passwords, clock);
  }

  /** Registers work that must run in the purge transaction before the accounts are deleted. */
  addPurgeHook(hook: PurgeHook): void {
    this.purgeHooks.push(hook);
  }

  get graceDays(): number {
    return Math.max(0, Math.floor(this.options.deletionGraceDays));
  }

  async info(userId: string): Promise<AccountDto> {
    const account = await this.users.getAccountById(userId);
    if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);
    return toAccountDto(account);
  }

  /** Guest → registered: sets email + password. The current session and refresh token stay valid. */
  async linkEmail(userId: string, deviceId: string, email: string, password: string): Promise<AccountDto> {
    // Cheap pre-check so registered accounts don't pay for an Argon2 hash; re-checked under lock below.
    const current = await this.users.getAccountById(userId);
    if (!current) throw new AppError(ErrorCode.UNAUTHORIZED);
    if (!current.isGuest) throw new AppError(ErrorCode.ACCOUNT_NOT_GUEST);

    const passwordHash = await this.passwords.hash(password);
    try {
      await this.uow.transaction(async (session) => {
        const account = await this.users.getAccountById(userId, session, true);
        if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);
        if (!account.isGuest) throw new AppError(ErrorCode.ACCOUNT_NOT_GUEST);
        // Login accepts email OR username, so the email must not match another account's email or username.
        if (await this.users.existsByEmailOrUsername(email, email, session)) {
          throw new AppError(ErrorCode.AUTH_EMAIL_OR_USERNAME_TAKEN);
        }

        await this.users.updateCredentials(userId, email, passwordHash, false, this.clock.now(), session);
        await this.users.audit(userId, "LINK_EMAIL", { deviceId }, session);
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError(ErrorCode.AUTH_EMAIL_OR_USERNAME_TAKEN);
      throw error;
    }

    return this.info(userId);
  }

  /** Changes the password and logs every other device out (the calling device keeps its session). */
  async changePassword(userId: string, deviceId: string, currentPassword: string, newPassword: string): Promise<RevokedDevicesResultDto> {
    const current = await this.users.getAccountById(userId);
    if (!current) throw new AppError(ErrorCode.UNAUTHORIZED);
    if (current.isGuest) throw new AppError(ErrorCode.ACCOUNT_IS_GUEST);

    const newHash = newPassword === currentPassword ? null : await this.passwords.hash(newPassword);

    const revokedTokens = await runCommitted(this.uow, async (session) => {
      const account = await this.users.getAccountById(userId, session, true);
      if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);
      if (account.isGuest) throw new AppError(ErrorCode.ACCOUNT_IS_GUEST);
      // Wrong password counts toward the login lock (committed); a locked account answers AUTH_ACCOUNT_LOCKED.
      if (!(await this.guard.verify(account, currentPassword, session))) return committedFailure(ErrorCode.ACCOUNT_WRONG_PASSWORD);
      if (!newHash) throw new AppError(ErrorCode.ACCOUNT_SAME_PASSWORD);

      await this.guard.reset(account, session);
      await this.users.updatePasswordHash(userId, newHash, this.clock.now(), session);
      const devices = await this.users.revokeRefreshTokensExcept(userId, deviceId, session);
      await this.users.audit(userId, "PASSWORD_CHANGE", { deviceId, revokedTokens: devices.length }, session);
      return devices;
    });

    return { revokedDevices: await this.countRevoked(userId, deviceId, revokedTokens) };
  }

  /** Revokes the refresh tokens and sessions of every device except the caller's. */
  async logoutOtherDevices(userId: string, deviceId: string): Promise<RevokedDevicesResultDto> {
    const revokedTokens = await this.uow.transaction(async (session) => {
      const account = await this.users.getAccountById(userId, session, true);
      if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);
      const devices = await this.users.revokeRefreshTokensExcept(userId, deviceId, session);
      await this.users.audit(userId, "LOGOUT_OTHERS", { deviceId, revokedTokens: devices.length }, session);
      return devices;
    });

    return { revokedDevices: await this.countRevoked(userId, deviceId, revokedTokens) };
  }

  /**
   * Schedules the account for deletion (now + grace days) and revokes every refresh token. Sessions (including the
   * caller's) are deleted by `afterResponse`, which the room runs once the reply is on its way.
   * Registered accounts must confirm with their password; guests have none.
   */
  async requestDeletion(userId: string, deviceId: string, password: string | undefined): Promise<DeletionRequestOutcome> {
    const graceDays = this.graceDays;

    const scheduledAt = await runCommitted(this.uow, async (session) => {
      const account = await this.users.getAccountById(userId, session, true);
      if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);

      if (!account.isGuest) {
        if (!password) return committedFailure(ErrorCode.ACCOUNT_WRONG_PASSWORD);
        if (!(await this.guard.verify(account, password, session))) return committedFailure(ErrorCode.ACCOUNT_WRONG_PASSWORD);
        await this.guard.reset(account, session);
      }

      // A repeated request keeps the original schedule (the grace period is never extended).
      let scheduled = account.deletionScheduledAt;
      if (!scheduled) {
        // Whole seconds: DATETIME has no fractions, and the response must match what the purge job compares.
        const requestedAt = new Date(Math.floor(this.clock.nowMs() / 1000) * 1000);
        scheduled = new Date(requestedAt.getTime() + graceDays * DAY_MS);
        await this.users.setDeletionSchedule(userId, requestedAt, scheduled, session);
        await this.users.audit(userId, "DELETION_REQUESTED", { deviceId, graceDays, scheduledAt: scheduled.toISOString() }, session);
      }

      await this.users.revokeAllRefreshTokens(userId, session);
      return scheduled;
    });

    return {
      deletionScheduledAtUnix: Math.floor(scheduledAt.getTime() / 1000),
      graceDays,
      afterResponse: async () => {
        await this.safely("all-sessions delete", () => this.sessions.deleteAllSessions(userId));
        this.sessionsRevoked(userId);
        if (graceDays === 0) await this.safely("immediate purge", async () => void (await this.purgeDueAccounts()));
      },
    };
  }

  /**
   * Hard-deletes every account whose deletion_scheduled_at has passed. Player data goes through the FK cascades;
   * each purge leaves an `ACCOUNT_PURGED` audit row without personal data (user_id NULL, hashed id).
   */
  async purgeDueAccounts(): Promise<number> {
    const batchSize = Math.max(1, this.options.purgeBatchSize ?? 100);
    let total = 0;

    for (let round = 0; round < 10_000; round++) {
      const purged = await this.uow.transaction(async (session) => {
        const due = await this.users.findUsersDueForDeletion(this.clock.now(), batchSize, session);
        if (due.length === 0) return [];
        for (const hook of this.purgeHooks) await hook(due, session);
        await this.users.deleteUsers(due, session);
        for (const userId of due) {
          await this.users.audit(null, "ACCOUNT_PURGED", { purgedUserIdHash: purgedUserIdHash(userId) }, session);
        }
        return due;
      });

      for (const userId of purged) {
        await this.safely("all-sessions delete", () => this.sessions.deleteAllSessions(userId));
        this.sessionsRevoked(userId);
      }
      total += purged.length;
      if (purged.length < batchSize) break;
    }

    return total;
  }

  /** Deletes the other devices' sessions and counts the distinct devices logged out (tokens ∪ sessions). */
  private async countRevoked(userId: string, deviceId: string, revokedTokens: string[]): Promise<number> {
    const devices = new Set(revokedTokens);
    try {
      for (const removed of await this.sessions.deleteSessionsExcept(userId, deviceId)) devices.add(removed);
    } catch (error) {
      logger.warn("other-sessions delete failed:", (error as Error).message);
    }
    // The calling device keeps its session: the rooms only close the connections whose session is gone.
    this.sessionsRevoked(userId);
    return devices.size;
  }

  private sessionsRevoked(userId: string): void {
    try {
      (this.options.onSessionsRevoked ?? notifyUserRevoked)(userId);
    } catch (error) {
      logger.warn("revocation notice failed:", (error as Error).message);
    }
  }

  private async safely(label: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      logger.warn(`${label} failed:`, (error as Error).message);
    }
  }
}
