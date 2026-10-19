import assert from "node:assert/strict";

import { matchMaker } from "@colyseus/core";

import { env as serverEnv } from "../src/config/env";
import { AccountService } from "../src/modules/account/account.service";
import { AuthService } from "../src/modules/auth/auth.service";
import { ChatRoom } from "../src/modules/chat/chat.room";
import { ChatOccupancy } from "../src/modules/chat/chat.occupancy";
import { ChatService } from "../src/modules/chat/chat.service";
import { EconomyService } from "../src/modules/economy/economy.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { HeartbeatGate, HEARTBEAT_MIN_INTERVAL_MS } from "../src/modules/presence/presence.heartbeat";
import type { PresenceConnection, PresenceRepository } from "../src/modules/presence/presence.ports";
import { PresenceRoom } from "../src/modules/presence/presence.room";
import { PresenceService, SESSION_RETENTION_DAYS } from "../src/modules/presence/presence.service";
import { ProfileService } from "../src/modules/profile/profile.service";
import { AppError } from "../src/shared/errors/app-error";
import { FixedClock } from "../src/shared/kernel/clock";
import { createSeededRandom } from "../src/shared/kernel/random";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room";
import { addressOf, bindRoom } from "../src/shared/rooms/base-room";
import {
  clientAddress,
  configureClientAddress,
  forwardedAddressOf,
  normalizeAddress,
  resolveClientAddress,
} from "../src/shared/rooms/client-address";
import {
  closeRevokedClients,
  configureRevocationSubscriber,
  configureUserRevocation,
  notifyUserRevoked,
  parseUserRevoked,
  USER_REVOKED_TOPIC,
} from "../src/shared/rooms/user-revocation";
import type { AccessAuthenticator } from "../src/shared/security/access-authenticator";
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

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const SECRET = "unit-test-secret-0123456789abcdef";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Published = Array<{ topic: string; payload: string }>;

function captureRevocations(): Published {
  const published: Published = [];
  configureUserRevocation(() => ({ publish: (topic, payload) => { published.push({ topic, payload }); } }));
  return published;
}

function restoreRevocationDefault(): void {
  configureUserRevocation(() => matchMaker.presence);
}

function wsClient(userId: string, deviceId: string, remoteAddress?: string, stored: string | null = null) {
  const left: Array<{ code?: number; reason?: string }> = [];
  return {
    sessionId: `s-${userId}-${deviceId}`,
    auth: { userId, username: userId, deviceId, accessJti: `jti-${deviceId}`, address: stored },
    userData: {} as Record<string, unknown>,
    ref: { _socket: { remoteAddress } },
    left,
    leave: (code?: number, reason?: string) => { left.push({ code, reason }); },
    send: () => {},
  };
}

describe("Revoked sessions stop receiving pushes", () => {
  after(restoreRevocationDefault);

  it("publishes a minimal event on the presence topic and survives a missing / failing presence", () => {
    const published = captureRevocations();
    notifyUserRevoked("u1");
    notifyUserRevoked("");
    assert.deepEqual(published, [{ topic: USER_REVOKED_TOPIC, payload: JSON.stringify({ userId: "u1" }) }]);

    configureUserRevocation(() => undefined);
    assert.doesNotThrow(() => notifyUserRevoked("u1"));
    configureUserRevocation(() => ({ publish: () => { throw new Error("redis down"); } }));
    assert.doesNotThrow(() => notifyUserRevoked("u1"));
    configureUserRevocation(() => ({ publish: () => Promise.reject(new Error("redis down")) }));
    assert.doesNotThrow(() => notifyUserRevoked("u1"));
  });

  it("parses events from strings and buffers and rejects malformed ones", () => {
    assert.equal(parseUserRevoked(JSON.stringify({ userId: "u1" })), "u1");
    assert.equal(parseUserRevoked(Buffer.from(JSON.stringify({ userId: "u2" }))), "u2");
    for (const bad of ["not json", "{}", JSON.stringify({ userId: 5 }), JSON.stringify({ userId: "" }), null, undefined, 7]) {
      assert.equal(parseUserRevoked(bad), null, String(bad));
    }
  });

  it("closes only the connections whose session is gone (the calling device stays)", async () => {
    const kept = wsClient("u1", "phone");
    const revoked = wsClient("u1", "tablet");
    const other = wsClient("u2", "tablet");
    const failing = wsClient("u1", "lookup-error");
    const active = new Set(["phone"]);

    const closed = await closeRevokedClients([kept, revoked, other, failing], "u1", async (client) => {
      if (client.auth.deviceId === "lookup-error") throw new Error("redis down");
      return active.has(client.auth.deviceId);
    });

    assert.equal(closed, 1);
    assert.deepEqual(revoked.left, [{ code: 4401, reason: "session revoked" }]);
    assert.deepEqual(kept.left, []);
    assert.deepEqual(other.left, [], "other users are untouched even though their session lookup would say inactive");
    assert.deepEqual(failing.left, [], "a failing lookup never closes a connection");
  });

  describe("Authenticated rooms", () => {
    // The room must subscribe on its own (fake) presence even when an earlier test booted a real server.
    before(() => configureRevocationSubscriber(() => undefined));
    after(() => configureRevocationSubscriber(() => matchMaker.presence));

    function authenticatedRoom() {
      const active = new Set<string>();
      configureRoomAuthentication({
        authenticate: async () => null,
        isSessionActive: async (identity: { userId: string; deviceId: string }) => active.has(`${identity.userId}|${identity.deviceId}`),
      } as unknown as AccessAuthenticator);

      const chat = new ChatService(
        { insertMessage: async () => {}, fetchHistory: async () => [] },
        new ChatOccupancy(),
        async () => null,
        () => ({ dirInitialPool: 1, dirMaxPool: 3, dirRecommended: 50, msgMin: 1, msgMax: 100, rateTokensPer10s: 10, rateBurst: 10, userWindowSec: 10, userMaxInWindow: 10, dupMuteBaseSec: 5 }),
        new FixedClock(T0),
      );
      const Bound: any = bindRoom(ChatRoom, { chat });
      const room: any = new Bound();
      const subscriptions = new Map<string, (raw: unknown) => void>();
      const unsubscribed: string[] = [];
      room.presence = {
        subscribe: (topic: string, callback: (raw: unknown) => void) => { subscriptions.set(topic, callback); },
        unsubscribe: (topic: string) => { unsubscribed.push(topic); },
        publish() {},
      };
      room.setMetadata = () => {};
      room.onMessage = () => {};
      return { room, subscriptions, unsubscribed, active };
    }

    it("subscribes on create, drops revoked connections of the user and unsubscribes on dispose", async () => {
      const { room, subscriptions, unsubscribed, active } = authenticatedRoom();
      await room.onCreate({ channel: 0 });
      const handler = subscriptions.get(USER_REVOKED_TOPIC);
      assert.ok(handler, "the room must listen to the revocation event");

      const phone = wsClient("u1", "phone");
      const tablet = wsClient("u1", "tablet");
      const stranger = wsClient("u2", "tablet");
      room.clients = [phone, tablet, stranger];
      active.add("u1|phone"); // logout_other_devices / change_password keep the calling device

      handler!(JSON.stringify({ userId: "u1" }));
      await tick();
      await tick();
      assert.deepEqual(tablet.left, [{ code: 4401, reason: "session revoked" }]);
      assert.deepEqual(phone.left, []);
      assert.deepEqual(stranger.left, []);

      handler!("garbage");
      await tick();
      assert.equal(phone.left.length, 0);

      await room.onDispose();
      assert.deepEqual(unsubscribed, [USER_REVOKED_TOPIC]);
    });
  });

  describe("Services publish after deleting sessions", () => {
    function accountSetup(failing = false) {
      const clock = new FixedClock(T0);
      const users = new InMemoryAuthRepository(() => clock.now());
      const profilesRepo = new InMemoryProfileRepository();
      const wallets = new InMemoryWalletRepository();
      const uow = new InMemoryUnitOfWork().register(users).register(profilesRepo).register(wallets);
      const currencies = currencyRulesOf([{ id: "GO", initialAmount: 100 }]);
      const economy = new EconomyService(wallets, new WalletLedger(wallets, currencies, clock), currencies, uow, clock);
      const profiles = new ProfileService(profilesRepo, { exists: () => true, defaultIconId: () => "icon_1" }, () => ({ minLength: 3, maxLength: 32, canUseSpecialChar: true }), createSeededRandom(7));
      const sessions = new InMemorySessionStore();
      const passwords = new PlainPasswordHasher();
      const revoked: Array<{ userId: string; devices: string[] }> = [];
      const onSessionsRevoked = (userId: string) => {
        revoked.push({ userId, devices: sessions.devices(userId) });
        if (failing) throw new Error("boom");
      };
      const auth = new AuthService(users, profiles, economy, sessions, new JwtAccessTokenService(SECRET, 10), passwords, new Sha256RefreshTokenHasher("pepper"), uow, clock, { refreshTtlDays: 14, onSessionsRevoked });
      const accounts = new AccountService(users, passwords, sessions, uow, clock, { deletionGraceDays: 30, onSessionsRevoked });
      return { auth, accounts, sessions, revoked };
    }

    it("logout other devices and password change announce the revocation once the other sessions are gone", async () => {
      const env = accountSetup();
      const phone = await env.auth.register("a@example.com", "alice", "secret-1", { deviceId: "phone" });
      const userId = phone.result.userId;
      await env.auth.login("alice", "secret-1", { deviceId: "tablet" });
      assert.deepEqual(env.sessions.devices(userId), ["phone", "tablet"]);

      await env.accounts.logoutOtherDevices(userId, "phone");
      assert.deepEqual(env.revoked, [{ userId, devices: ["phone"] }]);

      await env.auth.login("alice", "secret-1", { deviceId: "tablet" });
      env.revoked.length = 0;
      await env.accounts.changePassword(userId, "phone", "secret-1", "secret-2");
      assert.deepEqual(env.revoked, [{ userId, devices: ["phone"] }]);
    });

    it("a deletion request announces after every session (the caller's too) is deleted", async () => {
      const env = accountSetup();
      const phone = await env.auth.register("a@example.com", "alice", "secret-1", { deviceId: "phone" });
      const userId = phone.result.userId;
      const outcome = await env.accounts.requestDeletion(userId, "phone", "secret-1");
      assert.deepEqual(env.revoked, []);
      await outcome.afterResponse();
      assert.deepEqual(env.revoked, [{ userId, devices: [] }]);
    });

    it("logout and ban announce too, and a failing notifier never breaks the revocation", async () => {
      const env = accountSetup();
      const phone = await env.auth.register("a@example.com", "alice", "secret-1", { deviceId: "phone" });
      const userId = phone.result.userId;
      await env.auth.logout(userId, phone.result.refreshToken, "phone");
      assert.deepEqual(env.revoked, [{ userId, devices: [] }]);

      await env.auth.banUser(userId, "spam", null);
      assert.equal(env.revoked.length, 2);

      const broken = accountSetup(true);
      const tablet = await broken.auth.register("b@example.com", "bob", "secret-1", { deviceId: "tablet" });
      await broken.auth.logout(tablet.result.userId, tablet.result.refreshToken, "tablet");
      assert.deepEqual(broken.sessions.devices(tablet.result.userId), []);
      assert.equal(broken.revoked.length, 1);
    });
  });

  describe("GM kick (presence room)", () => {
    it("tells every room after notifying the presence connections, once per burst", async () => {
      const published = captureRevocations();
      const Bound: any = bindRoom(PresenceRoom, {} as any);
      const first: any = new Bound();
      const second: any = new Bound();
      const notices: string[] = [];
      const target = wsClient("kick-target", "phone");
      (target as any).send = (type: string) => { notices.push(type); };
      first.clients = [target];
      second.clients = [];

      const payload = { closeCode: 4401, reason: "bye", createdAt: new Date().toISOString() };
      assert.equal(first.kickUser("kick-target", payload), 1);
      assert.equal(second.kickUser("kick-target", payload), 0); // a user without a presence socket is still announced
      assert.deepEqual(notices, ["disconnect_notice"]);
      assert.deepEqual(target.left, [{ code: 4401, reason: "bye" }]);
      assert.equal(published.filter((entry) => entry.topic === USER_REVOKED_TOPIC).length, 1, "presence rooms of one process publish once");

      restoreRevocationDefault();
    });
  });
});

describe("Presence heartbeat throttle", () => {
  it("accepts the first heartbeat and ignores the ones closer than the minimum interval", () => {
    const gate = new HeartbeatGate();
    assert.equal(gate.accept(1_000), true);
    assert.equal(gate.accept(1_000 + HEARTBEAT_MIN_INTERVAL_MS - 1), false);
    assert.equal(gate.accept(1_000 + HEARTBEAT_MIN_INTERVAL_MS), true);
    assert.equal(gate.accept(1_000 + HEARTBEAT_MIN_INTERVAL_MS + 5), false);
  });

  it("the normal 15 s client interval is never throttled", () => {
    const gate = new HeartbeatGate();
    for (let i = 0; i < 20; i++) assert.equal(gate.accept(i * 15_000), true);
  });

  it("the room skips the session lookup and the database write of a flood", async () => {
    let sessionChecks = 0;
    configureRoomAuthentication({
      authenticate: async () => null,
      isSessionActive: async () => { sessionChecks++; return true; },
    } as unknown as AccessAuthenticator);
    const touches: string[] = [];
    const presence = { touch: async (sessionId: string) => { touches.push(sessionId); }, getOnlineCount: async () => 0, pruneSessions: async () => 0 };
    const Bound: any = bindRoom(PresenceRoom, { presence, maintenanceState: () => ({}), reports: {}, reportLimiter: { allow: () => true } } as any);
    const room: any = new Bound();
    const handlers = new Map<string, (client: any) => void>();
    room.onMessage = (type: string, handler: (client: any) => void) => { handlers.set(type, handler); };
    room.presence = { subscribe() {}, unsubscribe() {}, publish() {} };
    room.clock = { setInterval() {}, setTimeout() {} };
    room.onCreate();

    const client = wsClient("u1", "phone");
    const other = wsClient("u2", "phone");
    for (let i = 0; i < 25; i++) handlers.get("hb")!(client);
    handlers.get("hb")!(other); // another connection has its own gate
    await tick();
    await tick();

    assert.equal(sessionChecks, 2);
    assert.deepEqual(touches.sort(), [client.sessionId, other.sessionId].sort());
  });
});

describe("User_sessions pruning", () => {
  function fakeRepo(totalStale: number) {
    const calls: Array<{ before: Date; limit: number }> = [];
    let remaining = totalStale;
    const repo: PresenceRepository = {
      upsertSession: async (_connection: PresenceConnection) => {},
      markDisconnected: async () => {},
      touchSession: async () => {},
      countOnline: async () => 0,
      deleteStaleSessions: async (before, limit) => {
        calls.push({ before, limit });
        const removed = Math.min(limit, remaining);
        remaining -= removed;
        return removed;
      },
    };
    return { repo, calls, left: () => remaining };
  }

  it("deletes rows older than the retention window in bounded batches", async () => {
    const clock = new FixedClock(T0);
    const { repo, calls, left } = fakeRepo(2_500);
    const service = new PresenceService(repo, { now: () => clock.nowMs() });

    assert.equal(await service.pruneSessions(), 2_500);
    assert.equal(left(), 0);
    assert.equal(calls.length, 3); // 1000 + 1000 + 500
    assert.equal(calls[0].before.getTime(), T0 - SESSION_RETENTION_DAYS * 86_400_000);
  });

  it("stops after a bounded number of batches so one run never hogs the database", async () => {
    const { repo, calls, left } = fakeRepo(1_000_000);
    const service = new PresenceService(repo);
    const removed = await service.pruneSessions();
    assert.equal(removed, 20_000);
    assert.equal(calls.length, 20);
    assert.ok(left() > 0);
  });

  it("does nothing when there are no old rows", async () => {
    const { repo, calls } = fakeRepo(0);
    assert.equal(await new PresenceService(repo).pruneSessions(), 0);
    assert.equal(calls.length, 1);
  });

  it("honours a custom retention", async () => {
    const clock = new FixedClock(T0);
    const { repo, calls } = fakeRepo(1);
    await new PresenceService(repo, { retentionDays: 7, now: () => clock.nowMs() }).pruneSessions();
    assert.equal(calls[0].before.getTime(), T0 - 7 * 86_400_000);
  });
});

describe("Client address resolution", () => {
  const original = { trustProxy: serverEnv.trustProxy, trustedProxies: serverEnv.trustedProxies };
  afterEach(() => configureClientAddress(original));

  const spoofed = "6.6.6.6";

  it("ignores forwarded headers by default: the socket address is used", () => {
    configureClientAddress({ trustProxy: false, trustedProxies: [] });
    const client = wsClient("u1", "d", "203.0.113.9", spoofed);
    assert.equal(clientAddress(client as any), "203.0.113.9");
    assert.equal(addressOf(client as any), "203.0.113.9");
    assert.equal(forwardedAddressOf({ ip: spoofed, headers: new Headers() } as any), null);
  });

  it("falls back to the session id (rate-limit key) when the transport exposes no address", () => {
    configureClientAddress({ trustProxy: false, trustedProxies: [] });
    const client = wsClient("u1", "d", undefined, spoofed);
    assert.equal(clientAddress(client as any), null);
    assert.equal(addressOf(client as any), client.sessionId);
  });

  it("with TRUST_PROXY the forwarded address wins, the socket is the fallback", () => {
    configureClientAddress({ trustProxy: true, trustedProxies: [] });
    assert.equal(forwardedAddressOf({ ip: "198.51.100.7", headers: new Headers() } as any), "198.51.100.7");
    assert.equal(clientAddress(wsClient("u1", "d", "10.0.0.2", "198.51.100.7") as any), "198.51.100.7");
    assert.equal(clientAddress(wsClient("u1", "d", "10.0.0.2", null) as any), "10.0.0.2");
  });

  it("with TRUSTED_PROXIES only those peers may set the forwarded address", () => {
    configureClientAddress({ trustProxy: true, trustedProxies: ["10.0.0.2", "::1"] });
    assert.equal(clientAddress(wsClient("u1", "d", "10.0.0.2", "198.51.100.7") as any), "198.51.100.7");
    assert.equal(clientAddress(wsClient("u1", "d", "::ffff:10.0.0.2", "198.51.100.7") as any), "198.51.100.7");
    assert.equal(clientAddress(wsClient("u1", "d", "203.0.113.9", spoofed) as any), "203.0.113.9", "a direct client can't spoof it");
    assert.equal(resolveClientAddress(wsClient("u1", "d", undefined) as any, spoofed), null);
  });

  it("normalizes IPv4-mapped IPv6 addresses", () => {
    assert.equal(normalizeAddress("::ffff:192.0.2.1"), "192.0.2.1");
    assert.equal(normalizeAddress("2001:db8::1"), "2001:db8::1");
    assert.equal(normalizeAddress("  "), null);
    assert.equal(normalizeAddress(undefined), null);
  });

  it("env defaults to not trusting proxies", () => {
    assert.equal(serverEnv.trustProxy, false);
    assert.deepEqual(serverEnv.trustedProxies, []);
  });
});

describe("Nickname uniqueness race", () => {
  function profileService(failWith?: Error) {
    const repo = new InMemoryProfileRepository();
    repo.rows.set("u1", { name: "Old", iconId: "icon_1", level: 1, currentExp: 0 });
    if (failWith) repo.updateNickname = async () => { throw failWith; };
    const service = new ProfileService(repo, { exists: () => true, defaultIconId: () => "icon_1" }, () => ({ minLength: 3, maxLength: 32, canUseSpecialChar: true }), createSeededRandom(1));
    return { repo, service };
  }

  it("answers PROFILE_NAME_TAKEN when the unique index wins the race after the pre-check", async () => {
    const { service } = profileService(duplicateKeyError());
    await assert.rejects(service.changeNickname("u1", "Fresh"), (error: unknown) => error instanceof AppError && error.errorCode === "PROFILE_NAME_TAKEN");
  });

  it("keeps the pre-check answer and other errors untouched", async () => {
    const { repo, service } = profileService();
    repo.rows.set("u2", { name: "Taken", iconId: "icon_1", level: 1, currentExp: 0 });
    await assert.rejects(service.changeNickname("u1", "Taken"), (error: unknown) => error instanceof AppError && error.errorCode === "PROFILE_NAME_TAKEN");
    assert.deepEqual(await service.changeNickname("u1", " Fresh "), { nickname: "Fresh" });

    const broken = profileService(new Error("connection lost"));
    await assert.rejects(broken.service.changeNickname("u1", "Fresh"), /connection lost/);
  });
});
