// Pentest fix: per-account cap on simultaneous room connections + seat reservation rate limit.
import assert from "node:assert/strict";

import { ConnectionRegistry, configureConnectionLimits } from "../src/shared/rooms/connection-limits";
import { configureRoomAuthentication, AuthenticatedRoom } from "../src/shared/rooms/authenticated-room";
import { BaseRoom, bindRoom } from "../src/shared/rooms/base-room";
import { TokenBucketRateLimiter } from "../src/shared/security/rate-limiter";
import { env } from "../src/config/env";

describe("Fix: ConnectionRegistry", () => {
  it("caps connections per account and per room type, and frees slots on release", () => {
    const registry = new ConnectionRegistry({ maxPerUser: 5, maxPerRoomType: 2 });
    assert.equal(registry.tryAcquire("s1", "u1", "battle_pve"), true);
    assert.equal(registry.tryAcquire("s2", "u1", "battle_pve"), true);
    assert.equal(registry.tryAcquire("s3", "u1", "battle_pve"), false, "third battle room of the account");
    assert.equal(registry.tryAcquire("s4", "u1", "economy"), true);
    assert.equal(registry.tryAcquire("s5", "u1", "mail"), true);
    assert.equal(registry.tryAcquire("s6", "u1", "shop"), true);
    assert.equal(registry.tryAcquire("s7", "u1", "map"), false, "sixth connection of the account");
    assert.equal(registry.tryAcquire("s8", "u2", "map"), true, "other accounts are not affected");
    assert.equal(registry.countOf("u1"), 5);

    registry.release("s1");
    registry.release("unknown");
    assert.equal(registry.tryAcquire("s3", "u1", "battle_pve"), true);
    registry.release("s3");
    for (const key of ["s2", "s4", "s5", "s6", "s8"]) registry.release(key);
    assert.equal(registry.size, 0, "everything released, nothing leaks");
  });

  it("0 means unlimited; acquiring the same session twice counts once", () => {
    const registry = new ConnectionRegistry({ maxPerUser: 0, maxPerRoomType: 0 });
    for (let i = 0; i < 500; i++) assert.equal(registry.tryAcquire(`s${i}`, "u1", "economy"), true);
    const limited = new ConnectionRegistry({ maxPerUser: 1, maxPerRoomType: 0 });
    assert.equal(limited.tryAcquire("a", "u", "x"), true);
    assert.equal(limited.tryAcquire("a", "u", "x"), true);
    assert.equal(limited.countOf("u"), 1);
  });

  it("the shipped defaults leave room for a full client on two devices", () => {
    assert.ok(env.maxConnectionsPerUser >= 2 * 21, `MAX_CONNECTIONS_PER_USER ${env.maxConnectionsPerUser}`);
    assert.ok(env.maxConnectionsPerUserPerRoom >= 2);
  });
});

describe("Fix: bound rooms enforce the cap", () => {
  class Dummy extends BaseRoom<any, unknown> {
    joined: string[] = [];
    left: string[] = [];
    onJoin(client: any): void { this.joined.push(client.sessionId); }
    onLeave(client: any): void { this.left.push(client.sessionId); }
  }
  after(() => configureConnectionLimits({ maxPerUser: 0, maxPerRoomType: 0 }));

  it("refuses the connection over the cap before the room's onJoin and never forwards the refused leave", async () => {
    configureConnectionLimits({ maxPerUser: 2, maxPerRoomType: 0 });
    const Bound: any = bindRoom(Dummy, {});
    const room: any = new Bound();
    const mk = (sessionId: string, userId: string) => ({ sessionId, auth: { userId } });
    await room.onJoin(mk("a", "u1"));
    await room.onJoin(mk("b", "u1"));
    assert.throws(() => room.onJoin(mk("c", "u1")), (error: any) => error.code === 429 && /TOO_MANY/.test(error.message));
    assert.deepEqual(room.joined, ["a", "b"], "the room never saw the refused client");

    const refused = mk("c", "u1");
    assert.throws(() => room.onJoin(refused));
    await room.onLeave(refused); // what Colyseus does after a failed onJoin
    assert.deepEqual(room.left, [], "refused clients are not forwarded to the room's onLeave");

    await room.onLeave(mk("a", "u1"));
    await room.onJoin(mk("d", "u1"));
    assert.deepEqual(room.joined, ["a", "b", "d"]);
    await room.onJoin({ sessionId: "anon", auth: undefined }); // anonymous rooms are not counted
  });
});

describe("Fix: seat reservations are rate limited per account", () => {
  after(() => configureRoomAuthentication({ authenticate: async () => null, isSessionActive: async () => false } as any));

  it("onAuth answers 429 RATE_LIMIT once the account reserves seats too fast", async () => {
    const joinLimiter = new TokenBucketRateLimiter({ tokensPerInterval: 1, intervalMs: 60_000, burst: 2 });
    configureRoomAuthentication({
      authenticate: async (token?: string | null) => (token ? { userId: token, username: token, deviceId: "d", accessJti: "j" } : null),
      isSessionActive: async () => true,
    } as any, { joinLimiter });
    const call = (token: string) => (AuthenticatedRoom as any).onAuth("", { accessToken: token }, {});
    assert.ok(await call("u1"));
    assert.ok(await call("u1"));
    await assert.rejects(() => call("u1"), (error: any) => error.code === 429);
    assert.ok(await call("u2"), "another account is unaffected");
    assert.equal(await call(""), false, "an invalid token is still just refused");
  });
});
