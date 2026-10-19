// Pentest fix: `logout` needs the device's refresh token (user ids are public in chat lines), and access tokens need `exp`.
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { AuthService } from "../src/modules/auth/auth.service";
import { EconomyService } from "../src/modules/economy/economy.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { ProfileService } from "../src/modules/profile/profile.service";
import { FixedClock } from "../src/shared/kernel/clock";
import { createSeededRandom } from "../src/shared/kernel/random";
import { Sha256RefreshTokenHasher } from "../src/shared/security/password-hasher";
import { JWT_AUDIENCE, JWT_ISSUER, JwtAccessTokenService } from "../src/shared/security/token-service";
import {
  currencyRulesOf,
  InMemoryAuthRepository,
  InMemoryProfileRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryWalletRepository,
  PlainPasswordHasher,
} from "./support/fakes";

const SECRET = "unit-test-secret-0123456789abcdef";

function setup() {
  const clock = new FixedClock(Date.UTC(2026, 9, 17, 12, 0, 0));
  const users = new InMemoryAuthRepository(() => clock.now());
  const profilesRepo = new InMemoryProfileRepository();
  const wallets = new InMemoryWalletRepository();
  const uow = new InMemoryUnitOfWork().register(users).register(profilesRepo).register(wallets);
  const currencies = currencyRulesOf([{ id: "GO", initialAmount: 100 }]);
  const economy = new EconomyService(wallets, new WalletLedger(wallets, currencies, clock), currencies, uow, clock);
  const profiles = new ProfileService(profilesRepo, { exists: () => true, defaultIconId: () => "icon_1" }, () => ({ minLength: 3, maxLength: 32, canUseSpecialChar: true }), createSeededRandom(7));
  const sessions = new InMemorySessionStore();
  const revoked: string[] = [];
  const auth = new AuthService(users, profiles, economy, sessions, new JwtAccessTokenService(SECRET, 10), new PlainPasswordHasher(), new Sha256RefreshTokenHasher("pepper"), uow, clock, {
    refreshTtlDays: 14,
    onSessionsRevoked: (userId) => { revoked.push(userId); },
  });
  return { auth, users, sessions, revoked };
}

describe("Fix: logout requires the device's refresh token", () => {
  it("a logout with a wrong token, another user's token or an unknown user changes nothing", async () => {
    const env = setup();
    const alice = await env.auth.register("a@example.com", "alice", "secret-1", { deviceId: "default" });
    const bob = await env.auth.register("b@example.com", "bobby", "secret-1", { deviceId: "default" });
    const logBefore = JSON.stringify((env.users as any).tokenLog);

    await env.auth.logout(bob.result.userId, "not-the-token", "default");
    await env.auth.logout(bob.result.userId, alice.result.refreshToken, "default");
    await env.auth.logout("00000000-0000-0000-0000-000000000000", "x", "default");

    assert.deepEqual(env.sessions.devices(bob.result.userId), ["default"], "bob is still signed in");
    assert.deepEqual(env.sessions.devices(alice.result.userId), ["default"]);
    assert.deepEqual(env.revoked, [], "no revocation event was published");
    assert.equal(JSON.stringify((env.users as any).tokenLog), logBefore, "no REVOKE row was written for a forged logout");
  });

  it("the owner's refresh token still signs the device out", async () => {
    const env = setup();
    const alice = await env.auth.register("a@example.com", "alice", "secret-1", { deviceId: "phone" });
    await env.auth.logout(alice.result.userId, alice.result.refreshToken, "phone");
    assert.deepEqual(env.sessions.devices(alice.result.userId), []);
    assert.deepEqual(env.revoked, [alice.result.userId]);
  });
});

describe("Fix: access tokens without exp are refused", () => {
  const tokens = new JwtAccessTokenService(SECRET, 10);
  it("rejects a correctly signed token that never expires, accepts the service's own", () => {
    const forever = jwt.sign({ sub: "u", username: "x", deviceId: "d" }, SECRET, { algorithm: "HS256", jwtid: "j", issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    assert.equal(tokens.verify(forever), null);
    assert.ok(tokens.verify(tokens.sign("u", "x", "d").token));
  });
});
