import { v4 as uuidv4 } from "uuid";

import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import { guestName, randomToken, type PasswordHasher, type RefreshTokenHasher } from "../../shared/security/password-hasher.js";
import { notifyUserRevoked } from "../../shared/rooms/user-revocation.js";
import type { SessionStore } from "../../shared/security/session-store.js";
import type { AccessTokenService } from "../../shared/security/token-service.js";
import type { EconomyService } from "../economy/economy.service.js";
import type { ProfileService } from "../profile/profile.service.js";
import type { AccountDto, AuthOutcome, AuthResultDto, AuthSnapshotDto } from "./auth.dto.js";
import { toAccountDto, toSnapshotDto } from "./auth.mapper.js";
import type { AuthRepository, UserCredentialsRow } from "./auth.ports.js";
import { committedFailure, PasswordGuard, runCommitted } from "./password-guard.js";

/** Extra attempts when the random guest username collides (unique index). */
const GUEST_NAME_RETRIES = 5;

const logger = createLogger("AuthService");

export type AuthServiceOptions = {
  refreshTtlDays: number;
  /**
   * Called after the sessions of a user were deleted (logout, ban), so live connections of the revoked sessions are
   * closed (default: publishes the "user revoked" event the rooms listen to).
   */
  onSessionsRevoked?: (userId: string) => void;
};

/** Hook that adds feature data (e.g. map progress) to the account snapshot. */
export type SnapshotExtension = (userId: string) => Promise<Record<string, unknown>>;

type DeviceInfo = { deviceId?: string; ip?: string | null; userAgent?: string | null };

type IssuedCredentials = AuthResultDto & { accessJti: string };

/** `ACCOUNT_DELETION_PENDING` error (login/refresh of an account scheduled for deletion). */
export function deletionPendingError(scheduledAt: Date): AppError {
  return new AppError(ErrorCode.ACCOUNT_DELETION_PENDING, { extra: { scheduledAtUnix: Math.floor(scheduledAt.getTime() / 1000) } });
}

/** Account use cases: register, login, guest, refresh, logout, cancel deletion, ban. */
export class AuthService {
  private readonly snapshotExtensions: SnapshotExtension[] = [];
  private readonly guard: PasswordGuard;

  constructor(
    private readonly users: AuthRepository,
    private readonly profiles: ProfileService,
    private readonly economy: EconomyService,
    private readonly sessions: SessionStore,
    private readonly tokens: AccessTokenService,
    private readonly passwords: PasswordHasher,
    private readonly refreshHasher: RefreshTokenHasher,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly options: AuthServiceOptions,
  ) {
    this.guard = new PasswordGuard(users, passwords, clock);
  }

  /** Registers extra snapshot fields (composition root). */
  addSnapshotExtension(extension: SnapshotExtension): void {
    this.snapshotExtensions.push(extension);
  }

  async register(email: string, username: string, password: string, device: DeviceInfo): Promise<AuthOutcome> {
    const deviceId = device.deviceId || "default";
    const passwordHash = await this.passwords.hash(password);

    try {
      const issued = await this.uow.transaction(async (session) => {
        if (await this.users.existsByEmailOrUsername(email, username, session)) {
          throw new AppError(ErrorCode.AUTH_EMAIL_OR_USERNAME_TAKEN);
        }

        const userId = uuidv4();
        await this.users.insertUser(userId, email, username, passwordHash, false, session);
        await this.prepareAccount(userId, username, session);
        const credentials = await this.issueCredentials(userId, username, deviceId, device, "ISSUE", session);
        await this.users.audit(userId, "REGISTER", { ip: device.ip ?? null, deviceId }, session);
        return credentials;
      });

      return this.complete(issued, deviceId);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError(ErrorCode.AUTH_EMAIL_OR_USERNAME_TAKEN);
      throw error;
    }
  }

  async login(emailOrUsername: string, password: string, device: DeviceInfo): Promise<AuthOutcome> {
    const deviceId = device.deviceId || "default";

    // Failures that must keep their writes (failed-login counter, lifted bans) are returned, committed, then thrown.
    const issued = await runCommitted(this.uow, async (session) => {
      const user = await this.verifyCredentials(emailOrUsername, password, session);
      if (!user) return committedFailure(ErrorCode.AUTH_INVALID_CREDENTIALS);

      if (user.deletionScheduledAt) {
        await this.guard.reset(user, session);
        return committedFailure(ErrorCode.ACCOUNT_DELETION_PENDING, { scheduledAtUnix: unixOf(user.deletionScheduledAt) });
      }

      await this.users.markLoginSuccess(user.id, session);
      await this.prepareAccount(user.id, user.username, session);
      const credentials = await this.issueCredentials(user.id, user.username, deviceId, device, "ISSUE", session);
      await this.users.audit(user.id, "LOGIN", { ip: device.ip ?? null, deviceId }, session);
      return credentials;
    });

    return this.complete(issued, deviceId);
  }

  /** Undoes a pending deletion request (verified like a login) and logs the device in. */
  async cancelDeletion(emailOrUsername: string, password: string, device: DeviceInfo): Promise<AuthOutcome> {
    const deviceId = device.deviceId || "default";

    const issued = await runCommitted(this.uow, async (session) => {
      const user = await this.verifyCredentials(emailOrUsername, password, session);
      if (!user) return committedFailure(ErrorCode.AUTH_INVALID_CREDENTIALS);

      if (!user.deletionScheduledAt) {
        await this.guard.reset(user, session);
        return committedFailure(ErrorCode.ACCOUNT_NOT_PENDING_DELETION);
      }

      await this.users.setDeletionSchedule(user.id, null, null, session);
      await this.users.markLoginSuccess(user.id, session);
      await this.prepareAccount(user.id, user.username, session);
      const credentials = await this.issueCredentials(user.id, user.username, deviceId, device, "ISSUE", session);
      await this.users.audit(user.id, "DELETION_CANCELLED", { ip: device.ip ?? null, deviceId }, session);
      return credentials;
    });

    return this.complete(issued, deviceId);
  }

  async createGuest(device: DeviceInfo): Promise<AuthOutcome> {
    const deviceId = device.deviceId || "default";
    const passwordHash = await this.passwords.hash(randomToken());

    for (let attempt = 0; ; attempt++) {
      try {
        const issued = await this.uow.transaction(async (session) => {
          const userId = uuidv4();
          const username = guestName();
          await this.users.insertUser(userId, `guest+${userId}@local`, username, passwordHash, true, session);
          await this.prepareAccount(userId, username, session);
          const credentials = await this.issueCredentials(userId, username, deviceId, device, "ISSUE", session);
          await this.users.audit(userId, "REGISTER", { guest: true, ip: device.ip ?? null, deviceId }, session);
          return credentials;
        });
        return this.complete(issued, deviceId);
      } catch (error) {
        // The random `Guest-#####` name hit the unique index: roll back and draw another one.
        if (!isDuplicateKeyError(error) || attempt >= GUEST_NAME_RETRIES) throw error;
      }
    }
  }

  async refresh(userId: string, refreshToken: string, device: DeviceInfo): Promise<AuthOutcome> {
    const deviceId = device.deviceId || "default";
    const tokenHash = this.refreshHasher.hash(refreshToken);
    // Silent refresh: the new access token keeps the device's current session id, so rooms the client already
    // joined stay valid (they re-check the session jti) while new joins get a fresh, unexpired token.
    const keepJti = await this.currentAccessJti(userId, deviceId);

    const issued = await this.uow.transaction(async (session) => {
      const row = await this.users.findRefreshToken(userId, deviceId, tokenHash, session);
      if (!row) throw new AppError(ErrorCode.AUTH_INVALID_REFRESH);
      // A deletion request revokes every token; a holder of one of them is told why (and can cancel by logging in).
      if (row.deletionScheduledAt) throw deletionPendingError(row.deletionScheduledAt);
      if (row.isRevoked) throw new AppError(ErrorCode.AUTH_INVALID_REFRESH);

      if (row.isBanned && this.isBanActive(row.banExpiresAt)) {
        throw new AppError(ErrorCode.AUTH_BANNED, {
          extra: { reason: row.banReason ?? null, until: row.banExpiresAt?.toISOString() ?? null },
        });
      }

      const username = row.username || (await this.users.getUsername(userId, session)) || "Player";
      await this.prepareAccount(userId, username, session);
      const credentials = await this.issueCredentials(userId, username, deviceId, device, "REFRESH", session, keepJti);
      await this.users.audit(userId, "REFRESH", { ip: device.ip ?? null, deviceId }, session);
      return credentials;
    });

    return this.complete(issued, deviceId);
  }

  /**
   * Ends the device's session. The caller must prove it owns the device with its refresh token: user ids are visible to
   * other players (chat lines), so a logout whose token does not match revokes nothing. The answer is the same either way.
   */
  async logout(userId: string, refreshToken: string, deviceId = "default"): Promise<void> {
    const matched = await this.uow.transaction(async (session) => {
      const revoked = await this.users.revokeRefreshToken(userId, deviceId, this.refreshHasher.hash(refreshToken), session);
      if (revoked) await this.users.audit(userId, "LOGOUT", { deviceId }, session);
      return revoked;
    });
    if (!matched) return;
    await this.safely("session delete", () => this.sessions.deleteSession(userId, deviceId));
    this.sessionsRevoked(userId);
  }

  async banUser(userId: string, reason: string | null, until: Date | null): Promise<void> {
    await this.uow.transaction(async (session) => {
      await this.users.setBan(userId, true, reason, until, session);
      await this.users.audit(userId, "BAN", { reason, until: until?.toISOString() ?? null }, session);
    });
    await this.safely("all-sessions delete", () => this.sessions.deleteAllSessions(userId));
    this.sessionsRevoked(userId);
  }

  async unbanUser(userId: string): Promise<void> {
    await this.uow.transaction(async (session) => {
      await this.users.setBan(userId, false, null, null, session);
      await this.users.audit(userId, "UNBAN", null, session);
    });
  }

  /** Deletes revoked/expired refresh tokens older than the retention window. */
  async cleanupExpiredTokens(retentionDays: number): Promise<number> {
    return this.users.deleteExpiredRefreshTokens(retentionDays);
  }

  /** Builds the account snapshot (also used after reconnects). */
  async buildSnapshot(userId: string): Promise<AuthSnapshotDto & Record<string, unknown>> {
    const username = (await this.users.getUsername(userId)) || "Player";
    const profile = await this.profiles.getProfile(userId);
    const wallet = await this.economy.getWallet(userId);

    const snapshot: AuthSnapshotDto & Record<string, unknown> = { ...toSnapshotDto({
      nickname: profile?.name ?? username,
      level: profile?.level ?? 1,
      currentExp: profile?.currentExp ?? 0,
      wallet,
      iconId: profile?.iconId ?? null,
      serverTimeUnix: this.clock.nowUnix(),
    }) };

    for (const extension of this.snapshotExtensions) {
      Object.assign(snapshot, await extension(userId));
    }
    return snapshot;
  }

  /**
   * Login-style verification on the locked user row: unknown user (dummy hash), active ban (thrown), expired ban
   * (lifted), lock (thrown), password (wrong → failed counter, returns null; the caller must commit).
   */
  private async verifyCredentials(emailOrUsername: string, password: string, session: DbSession): Promise<UserCredentialsRow | null> {
    const user = await this.users.findByEmailOrUsername(emailOrUsername, session, true);
    if (!user) {
      await this.guard.dummyVerify(password);
      return null;
    }

    if (user.isBanned) {
      if (this.isBanActive(user.banExpiresAt)) {
        throw new AppError(ErrorCode.AUTH_BANNED, {
          extra: { reason: user.banReason ?? null, until: user.banExpiresAt?.toISOString() ?? null },
        });
      }
      await this.users.setBan(user.id, false, null, null, session);
    }

    return (await this.guard.verify(user, password, session)) ? user : null;
  }

  private async prepareAccount(userId: string, username: string, session: DbSession): Promise<void> {
    await this.profiles.ensureProfile(userId, username, session);
    await this.economy.ensureUserCurrencies(userId, session);
  }

  private async issueCredentials(
    userId: string,
    username: string,
    deviceId: string,
    device: DeviceInfo,
    action: "ISSUE" | "REFRESH",
    session: DbSession,
    keepJti?: string,
  ): Promise<IssuedCredentials> {
    const access = this.tokens.sign(userId, username, deviceId, keepJti);
    const refreshToken = randomToken();
    await this.users.saveRefreshToken({
      userId,
      deviceId,
      tokenHash: this.refreshHasher.hash(refreshToken),
      expiresAt: new Date(this.clock.nowMs() + this.options.refreshTtlDays * 86_400_000),
      ip: device.ip ?? null,
      userAgent: device.userAgent ?? null,
    }, action, session);

    return { userId, username, accessToken: access.token, refreshToken, accessJti: access.accessJti };
  }

  private async complete(issued: IssuedCredentials, deviceId: string): Promise<AuthOutcome> {
    const { accessJti, ...result } = issued;
    const account = await this.accountOf(result.userId);
    const snapshot = await this.buildSnapshot(result.userId);

    // Storing the session (with the new token id) invalidates older tokens of the same device.
    await this.safely("session store", () => this.sessions.setSession(result.userId, deviceId, {
      username: result.username,
      level: snapshot.level,
      nickname: snapshot.nickname,
      iconId: snapshot.iconId,
      accessJti,
    }));

    return { result, account, snapshot };
  }

  private async accountOf(userId: string): Promise<AccountDto> {
    const row = await this.users.getAccountById(userId);
    if (!row) throw new AppError(ErrorCode.UNAUTHORIZED);
    return toAccountDto(row);
  }

  private isBanActive(until: Date | null): boolean {
    return !until || until.getTime() > this.clock.nowMs();
  }

  /** Session id currently stored for the device (null when there is none or the cache is unreachable). */
  private async currentAccessJti(userId: string, deviceId: string): Promise<string | undefined> {
    try {
      return (await this.sessions.getSession(userId, deviceId))?.accessJti || undefined;
    } catch (error) {
      logger.warn("session read failed:", (error as Error).message);
      return undefined;
    }
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

function unixOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
