import assert from "node:assert/strict";

import { AccountPurgeJob } from "../src/infrastructure/maintenance/account-purge.job";
import { AccountService, purgedUserIdHash } from "../src/modules/account/account.service";
import { AccountMessageSchema } from "../src/modules/account/account.validation";
import { AuthService } from "../src/modules/auth/auth.service";
import { AuthMessageSchema } from "../src/modules/auth/auth.validation";
import { EconomyService } from "../src/modules/economy/economy.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { ProfileService } from "../src/modules/profile/profile.service";
import { AppError } from "../src/shared/errors/app-error";
import { isDuplicateKeyError } from "../src/shared/errors/db-errors";
import { FixedClock } from "../src/shared/kernel/clock";
import { createSeededRandom } from "../src/shared/kernel/random";
import { Sha256RefreshTokenHasher } from "../src/shared/security/password-hasher";
import { JwtAccessTokenService } from "../src/shared/security/token-service";
import {
  currencyRulesOf,
  duplicateKeyError,
  InMemoryAuthRepository,
  InMemoryProfileRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryWalletRepository,
  PlainPasswordHasher,
} from "./support/fakes";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const DAY_MS = 86_400_000;
const SECRET = "unit-test-secret-0123456789abcdef";

function setup(graceDays = 30) {
  const clock = new FixedClock(T0);
  const users = new InMemoryAuthRepository(() => clock.now());
  const profilesRepo = new InMemoryProfileRepository();
  const wallets = new InMemoryWalletRepository();
  const uow = new InMemoryUnitOfWork().register(users).register(profilesRepo).register(wallets);
  const currencies = currencyRulesOf([{ id: "GO", initialAmount: 100 }]);
  const economy = new EconomyService(wallets, new WalletLedger(wallets, currencies, clock), currencies, uow, clock);
  const profiles = new ProfileService(
    profilesRepo,
    { exists: () => true, defaultIconId: () => "icon_1" },
    () => ({ minLength: 3, maxLength: 32, canUseSpecialChar: true }),
    createSeededRandom(7),
  );
  const sessions = new InMemorySessionStore();
  const passwords = new PlainPasswordHasher();
  const auth = new AuthService(
    users, profiles, economy, sessions, new JwtAccessTokenService(SECRET, 10), passwords,
    new Sha256RefreshTokenHasher("pepper"), uow, clock, { refreshTtlDays: 14 },
  );
  const accounts = new AccountService(users, passwords, sessions, uow, clock, { deletionGraceDays: graceDays });
  return { clock, users, sessions, auth, accounts };
}

type Env = ReturnType<typeof setup>;

async function rejectsWith(promise: Promise<unknown>, code: string, extra?: Record<string, unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected AppError ${code}, got ${String(error)}`);
    assert.equal(error.errorCode, code);
    if (extra) assert.deepEqual(error.extra, extra);
    return true;
  });
}

async function registered(env: Env, deviceId = "dev-a", email = "alice@example.com", password = "secret-1") {
  return env.auth.register(email, "alice", password, { deviceId });
}

const kinds = (env: Env) => env.users.audits.map((entry) => entry.kind);

describe("Auth: account object and guest creation", () => {
  it("adds the account object to guest and register responses", async () => {
    const env = setup();
    const guest = await env.auth.createGuest({ deviceId: "g" });
    assert.deepEqual(guest.account, {
      userId: guest.result.userId,
      username: guest.result.username,
      isGuest: true,
      email: null,
      createdAtUnix: T0 / 1000,
      deletionScheduledAtUnix: null,
    });

    const alice = await registered(env);
    assert.equal(alice.account.isGuest, false);
    assert.equal(alice.account.email, "alice@example.com");
    assert.equal(env.users.users.get(guest.result.userId)!.isGuest, true);
  });

  it("retries the random guest name on duplicate keys (also when wrapped by Drizzle)", async () => {
    const env = setup();
    assert.equal(isDuplicateKeyError(duplicateKeyError()), true);
    assert.equal(isDuplicateKeyError(new Error("other")), false);

    env.users.failNextInserts = 3;
    const guest = await env.auth.createGuest({ deviceId: "g" });
    assert.equal(guest.account.isGuest, true);
    assert.equal(env.users.users.size, 1);

    env.users.failNextInserts = 10;
    await assert.rejects(env.auth.createGuest({ deviceId: "g2" }), (error) => isDuplicateKeyError(error));
  });

  it("maps a wrapped duplicate key on register to AUTH_EMAIL_OR_USERNAME_TAKEN", async () => {
    const env = setup();
    env.users.failNextInserts = 1;
    await rejectsWith(registered(env), "AUTH_EMAIL_OR_USERNAME_TAKEN");
  });
});

describe("Auth: silent refresh", () => {
  it("keeps the device session id so already joined rooms stay valid", async () => {
    const env = setup();
    const tokens = new JwtAccessTokenService(SECRET, 10);
    const guest = await env.auth.createGuest({ deviceId: "g" });
    const userId = guest.result.userId;
    const before = (await env.sessions.getSession(userId, "g"))!.accessJti;

    const refreshed = await env.auth.refresh(userId, guest.result.refreshToken, { deviceId: "g" });
    assert.equal((await env.sessions.getSession(userId, "g"))!.accessJti, before, "session jti kept");
    assert.equal(tokens.verify(refreshed.result.accessToken)!.jti, before, "new token carries the session jti");
    assert.notEqual(refreshed.result.refreshToken, guest.result.refreshToken, "refresh token still rotates");
    await rejectsWith(env.auth.refresh(userId, guest.result.refreshToken, { deviceId: "g" }), "AUTH_INVALID_REFRESH");
  });

  it("issues a new session id on a fresh login", async () => {
    const env = setup();
    const a = await registered(env, "dev-a");
    const first = (await env.sessions.getSession(a.result.userId, "dev-a"))!.accessJti;
    await env.auth.login("alice@example.com", "secret-1", { deviceId: "dev-a" });
    assert.notEqual((await env.sessions.getSession(a.result.userId, "dev-a"))!.accessJti, first);
  });
});

describe("Account: info and link_email", () => {
  it("links an email to a guest and keeps the current session and refresh token", async () => {
    const env = setup();
    const guest = await env.auth.createGuest({ deviceId: "g" });
    const userId = guest.result.userId;

    const account = await env.accounts.linkEmail(userId, "g", "bob@example.com", "bob-password");
    assert.equal(account.isGuest, false);
    assert.equal(account.email, "bob@example.com");
    assert.deepEqual(await env.accounts.info(userId), account);
    assert.ok(env.users.users.get(userId)!.passwordChangedAt);
    assert.ok(await env.sessions.getSession(userId, "g"), "session kept");
    assert.ok(kinds(env).includes("LINK_EMAIL"));

    const refreshed = await env.auth.refresh(userId, guest.result.refreshToken, { deviceId: "g" });
    assert.equal(refreshed.account.email, "bob@example.com");
    const login = await env.auth.login("bob@example.com", "bob-password", { deviceId: "other" });
    assert.equal(login.result.userId, userId);
  });

  it("refuses registered accounts and taken emails", async () => {
    const env = setup();
    const alice = await registered(env);
    await rejectsWith(env.accounts.linkEmail(alice.result.userId, "dev-a", "x@example.com", "password"), "ACCOUNT_NOT_GUEST");

    const guest = await env.auth.createGuest({ deviceId: "g" });
    await rejectsWith(env.accounts.linkEmail(guest.result.userId, "g", "alice@example.com", "password"), "AUTH_EMAIL_OR_USERNAME_TAKEN");
    await rejectsWith(env.accounts.linkEmail(guest.result.userId, "g", "alice", "password"), "AUTH_EMAIL_OR_USERNAME_TAKEN");
    assert.equal(env.users.users.get(guest.result.userId)!.isGuest, true, "nothing changed");
  });
});

describe("Account: change_password / logout_other_devices", () => {
  it("rejects guests, wrong and identical passwords; wrong ones count toward the lock", async () => {
    const env = setup();
    const guest = await env.auth.createGuest({ deviceId: "g" });
    await rejectsWith(env.accounts.changePassword(guest.result.userId, "g", "x", "new-password"), "ACCOUNT_IS_GUEST");

    const alice = await registered(env);
    const userId = alice.result.userId;
    await rejectsWith(env.accounts.changePassword(userId, "dev-a", "secret-1", "secret-1"), "ACCOUNT_SAME_PASSWORD");
    await rejectsWith(env.accounts.changePassword(userId, "dev-a", "wrong", "new-password"), "ACCOUNT_WRONG_PASSWORD");
    assert.equal(env.users.users.get(userId)!.failedLogins, 1, "failed counter committed");

    for (let i = 0; i < 5; i++) await rejectsWith(env.accounts.changePassword(userId, "dev-a", "wrong", "new-password"), "ACCOUNT_WRONG_PASSWORD");
    await rejectsWith(env.accounts.changePassword(userId, "dev-a", "secret-1", "new-password"), "AUTH_ACCOUNT_LOCKED");
    await rejectsWith(env.auth.login("alice", "secret-1", { deviceId: "dev-a" }), "AUTH_ACCOUNT_LOCKED");
  });

  it("changes the password and revokes every other device", async () => {
    const env = setup();
    const a = await registered(env, "dev-a");
    const b = await env.auth.login("alice", "secret-1", { deviceId: "dev-b" });
    await env.auth.login("alice", "secret-1", { deviceId: "dev-c" });
    const userId = a.result.userId;

    const result = await env.accounts.changePassword(userId, "dev-a", "secret-1", "brand-new");
    assert.deepEqual(result, { revokedDevices: 2 });
    assert.deepEqual(env.sessions.devices(userId), ["dev-a"]);
    assert.ok(kinds(env).includes("PASSWORD_CHANGE"));
    assert.equal(env.users.tokenLog.filter((row) => row.action === "REVOKE").length, 2);

    await rejectsWith(env.auth.refresh(userId, b.result.refreshToken, { deviceId: "dev-b" }), "AUTH_INVALID_REFRESH");
    await env.auth.refresh(userId, a.result.refreshToken, { deviceId: "dev-a" });
    await rejectsWith(env.auth.login("alice", "secret-1", { deviceId: "dev-b" }), "AUTH_INVALID_CREDENTIALS");
    await env.auth.login("alice", "brand-new", { deviceId: "dev-b" });
  });

  it("logs out other devices only", async () => {
    const env = setup();
    const a = await registered(env, "dev-a");
    await env.auth.login("alice", "secret-1", { deviceId: "dev-b" });
    const userId = a.result.userId;

    assert.deepEqual(await env.accounts.logoutOtherDevices(userId, "dev-a"), { revokedDevices: 1 });
    assert.deepEqual(env.sessions.devices(userId), ["dev-a"]);
    assert.deepEqual(await env.accounts.logoutOtherDevices(userId, "dev-a"), { revokedDevices: 0 });
    assert.equal(kinds(env).filter((kind) => kind === "LOGOUT_OTHERS").length, 2);
  });
});

describe("Account: request_deletion and the deletion lifecycle", () => {
  it("lets guests request deletion without a password and revokes everything after the reply", async () => {
    const env = setup();
    const guest = await env.auth.createGuest({ deviceId: "g" });
    const userId = guest.result.userId;

    const outcome = await env.accounts.requestDeletion(userId, "g", undefined);
    assert.equal(outcome.graceDays, 30);
    assert.equal(outcome.deletionScheduledAtUnix, (T0 + 30 * DAY_MS) / 1000);
    assert.ok(env.users.tokens.every((row) => row.isRevoked), "refresh tokens revoked");
    assert.deepEqual(env.sessions.devices(userId), ["g"], "the caller keeps its session until the reply is sent");

    await outcome.afterResponse();
    assert.deepEqual(env.sessions.devices(userId), []);
    assert.ok(kinds(env).includes("DELETION_REQUESTED"));
    assert.equal(env.users.users.has(userId), true, "not purged during the grace period");
  });

  it("requires the correct password of registered accounts (counts toward the lock)", async () => {
    const env = setup();
    const alice = await registered(env);
    const userId = alice.result.userId;

    await rejectsWith(env.accounts.requestDeletion(userId, "dev-a", undefined), "ACCOUNT_WRONG_PASSWORD");
    await rejectsWith(env.accounts.requestDeletion(userId, "dev-a", "wrong"), "ACCOUNT_WRONG_PASSWORD");
    assert.equal(env.users.users.get(userId)!.failedLogins, 1);
    assert.equal(env.users.users.get(userId)!.deletionScheduledAt, null);

    const outcome = await env.accounts.requestDeletion(userId, "dev-a", "secret-1");
    assert.equal(outcome.deletionScheduledAtUnix, (T0 + 30 * DAY_MS) / 1000);
    assert.equal(env.users.users.get(userId)!.failedLogins, 0);

    // A repeated request never extends the schedule.
    env.clock.advance(DAY_MS);
    const again = await env.accounts.requestDeletion(userId, "dev-a", "secret-1");
    assert.equal(again.deletionScheduledAtUnix, outcome.deletionScheduledAtUnix);
  });

  it("blocks login and refresh with ACCOUNT_DELETION_PENDING", async () => {
    const env = setup();
    const a = await registered(env, "dev-a");
    const b = await env.auth.login("alice", "secret-1", { deviceId: "dev-b" });
    const userId = a.result.userId;
    const scheduledAtUnix = (T0 + 30 * DAY_MS) / 1000;

    await env.accounts.requestDeletion(userId, "dev-a", "secret-1");

    // Wrong password: normal failure + counter; the pending state is only revealed to the right password.
    await rejectsWith(env.auth.login("alice", "wrong", { deviceId: "dev-a" }), "AUTH_INVALID_CREDENTIALS");
    assert.equal(env.users.users.get(userId)!.failedLogins, 1);
    await rejectsWith(env.auth.login("alice", "secret-1", { deviceId: "dev-a" }), "ACCOUNT_DELETION_PENDING", { scheduledAtUnix });
    assert.equal(env.users.users.get(userId)!.failedLogins, 0);

    // Tokens revoked by the request still answer why.
    await rejectsWith(env.auth.refresh(userId, b.result.refreshToken, { deviceId: "dev-b" }), "ACCOUNT_DELETION_PENDING", { scheduledAtUnix });
    await rejectsWith(env.auth.refresh(userId, "not-a-token", { deviceId: "dev-b" }), "AUTH_INVALID_REFRESH");
  });

  it("blocks refresh of a still valid token when the account is scheduled for deletion", async () => {
    const env = setup();
    const a = await registered(env, "dev-a");
    env.users.users.get(a.result.userId)!.deletionScheduledAt = new Date(T0 + DAY_MS);
    await rejectsWith(env.auth.refresh(a.result.userId, a.result.refreshToken, { deviceId: "dev-a" }), "ACCOUNT_DELETION_PENDING", {
      scheduledAtUnix: (T0 + DAY_MS) / 1000,
    });
  });

  it("cancel_deletion verifies like login, requires a pending deletion and logs in", async () => {
    const env = setup();
    const alice = await registered(env);
    const userId = alice.result.userId;

    await rejectsWith(env.auth.cancelDeletion("alice", "secret-1", { deviceId: "dev-a" }), "ACCOUNT_NOT_PENDING_DELETION");
    await env.accounts.requestDeletion(userId, "dev-a", "secret-1");

    await rejectsWith(env.auth.cancelDeletion("alice", "wrong", { deviceId: "dev-a" }), "AUTH_INVALID_CREDENTIALS");
    await rejectsWith(env.auth.cancelDeletion("nobody", "wrong", { deviceId: "dev-a" }), "AUTH_INVALID_CREDENTIALS");
    assert.equal(env.users.users.get(userId)!.failedLogins, 1);

    const restored = await env.auth.cancelDeletion("alice@example.com", "secret-1", { deviceId: "dev-a" });
    assert.equal(restored.result.userId, userId);
    assert.equal(restored.account.deletionScheduledAtUnix, null);
    assert.ok(restored.result.refreshToken && restored.result.accessToken);
    assert.ok(await env.sessions.getSession(userId, "dev-a"));
    assert.equal(env.users.users.get(userId)!.deletionRequestedAt, null);
    assert.ok(kinds(env).includes("DELETION_CANCELLED"));

    await env.auth.login("alice", "secret-1", { deviceId: "dev-b" });
  });
});

describe("Account purge job", () => {
  it("hard-deletes only accounts past their schedule and leaves an anonymous audit row", async () => {
    const env = setup(30);
    const early = await env.auth.createGuest({ deviceId: "g1" });
    await env.accounts.requestDeletion(early.result.userId, "g1", undefined);

    env.clock.advance(10 * DAY_MS);
    const late = await env.auth.createGuest({ deviceId: "g2" });
    await env.accounts.requestDeletion(late.result.userId, "g2", undefined);
    const kept = await registered(env);

    const job = new AccountPurgeJob(env.accounts);
    assert.equal(await job.run(), 0, "nothing due yet");

    env.clock.advance(20 * DAY_MS); // early: T0+30d (due), late: T0+40d (not due)
    assert.equal(await job.run(), 1);
    assert.equal(env.users.users.has(early.result.userId), false);
    assert.equal(env.users.users.has(late.result.userId), true);
    assert.equal(env.users.users.has(kept.result.userId), true);
    assert.equal(env.users.tokenLog.some((row) => row.userId === early.result.userId), false, "token log cleaned");

    const purged = env.users.audits.filter((entry) => entry.kind === "ACCOUNT_PURGED");
    assert.deepEqual(purged, [{ userId: null, kind: "ACCOUNT_PURGED", meta: { purgedUserIdHash: purgedUserIdHash(early.result.userId) } }]);
    assert.equal(JSON.stringify(purged).includes(early.result.userId), false, "no raw id stored");
    assert.equal(await job.runSafely(), 0);
  });

  it("purges right after the reply with a zero-day grace period", async () => {
    const env = setup(0);
    const guest = await env.auth.createGuest({ deviceId: "g" });
    const outcome = await env.accounts.requestDeletion(guest.result.userId, "g", undefined);
    assert.equal(outcome.graceDays, 0);
    assert.equal(outcome.deletionScheduledAtUnix, T0 / 1000);
    assert.equal(env.users.users.has(guest.result.userId), true);
    await outcome.afterResponse();
    assert.equal(env.users.users.has(guest.result.userId), false);
  });
});

describe("Account validation", () => {
  it("accepts the documented payloads only", () => {
    const ok = (payload: unknown) => AccountMessageSchema.safeParse(payload).success;
    assert.equal(ok({ type: "info" }), true);
    assert.equal(ok({ type: "request_deletion", confirm: "DELETE" }), true);
    assert.equal(ok({ type: "request_deletion", confirm: "delete" }), false);
    assert.equal(ok({ type: "request_deletion", confirm: "DELETE", userId: "someone-else" }), false);
    assert.equal(ok({ type: "link_email", email: "not-an-email", password: "password" }), false);
    assert.equal(ok({ type: "link_email", email: "a@b.co", password: "short" }), false);
    assert.equal(ok({ type: "change_password", currentPassword: "x", newPassword: "123456", isAdmin: true }), false);
    assert.equal(ok({ type: "logout_other_devices", deviceId: "spoofed" }), false);

    assert.equal(AuthMessageSchema.safeParse({ type: "cancel_deletion", emailOrUsername: "alice", password: "p", deviceId: "d" }).success, true);
    assert.equal(AuthMessageSchema.safeParse({ type: "cancel_deletion", emailOrUsername: "", password: "p" }).success, false);
  });
});
