import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { z } from "zod";

import { AppError } from "../src/shared/errors/app-error";
import { createLogger } from "../src/shared/logger";
import { executeRequest } from "../src/shared/rooms/request-handler";
import { AccessAuthenticator } from "../src/shared/security/access-authenticator";
import { TokenBucketRateLimiter } from "../src/shared/security/rate-limiter";
import type { SessionData, SessionStore } from "../src/shared/security/session-store";
import { JWT_AUDIENCE, JWT_ISSUER, JwtAccessTokenService } from "../src/shared/security/token-service";
import { strictPayload } from "../src/shared/validation";
import { adminKeyMatches, requireAdminKey } from "../src/modules/admin/admin-auth";
import { StageStartSchema } from "../src/modules/map/map.validation";
import { ShopPurchaseSchema } from "../src/modules/shop/shop.validation";

const SECRET = "unit-test-secret-0123456789abcdef";
const logger = createLogger("test");

class MemorySessions implements SessionStore {
  sessions = new Map<string, SessionData>();
  async setSession(userId: string, deviceId: string, data: SessionData) { this.sessions.set(`${userId}:${deviceId}`, data); }
  async getSession(userId: string, deviceId: string) { return this.sessions.get(`${userId}:${deviceId}`) ?? null; }
  async deleteSession(userId: string, deviceId: string) { this.sessions.delete(`${userId}:${deviceId}`); }
  async deleteAllSessions() { this.sessions.clear(); }
  async deleteSessionsExcept(userId: string, keepDeviceId: string) {
    const removed = [...this.sessions.keys()].filter((key) => key.startsWith(`${userId}:`) && key !== `${userId}:${keepDeviceId}`);
    removed.forEach((key) => this.sessions.delete(key));
    return removed.map((key) => key.slice(userId.length + 1));
  }
  async touchSession() {}
}

describe("Security: request edge", () => {
  const spec = {
    schema: strictPayload({ uid: z.string().max(10) }),
    handle: async (_ctx: unknown, payload: { uid: string }) => ({ ok: true, uid: payload.uid }),
  };

  it("rejects unknown fields (mass assignment), userId included", async () => {
    const run = (rawPayload: unknown) => executeRequest({ type: "t", rawPayload, messageContext: { id: 1 } as any, spec, logger, rateLimitKey: "u", resolveContext: async () => ({}) });

    assert.deepEqual(await run({ uid: "a", isAdmin: true }), { ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await run({ uid: "a", userId: "someone-else" }), { ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await run({ uid: "x".repeat(11) }), { ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await run({ uid: "a" }), { ok: true, uid: "a" });
  });

  it("never leaks internal errors", async () => {
    const quietLogger = { ...logger, error: () => undefined };
    const response = await executeRequest({
      type: "t", rawPayload: { uid: "a" }, messageContext: { id: 1 } as any, logger: quietLogger, rateLimitKey: "u",
      spec: { ...spec, handle: async () => { throw new Error("ER_PARSE_ERROR near 'SELECT * FROM users'"); } },
      resolveContext: async () => ({}),
    });
    assert.deepEqual(response, { ok: false, error: "SERVER_ERROR" });
  });

  it("ignores fire-and-forget sends (no request id): nothing is executed", async () => {
    let handled = 0;
    const response = await executeRequest({
      type: "t", rawPayload: { uid: "a" }, messageContext: undefined, logger, rateLimitKey: "u",
      spec: { ...spec, handle: async () => { handled++; return { ok: true }; } },
      resolveContext: async () => ({}),
    });
    assert.equal(response, undefined);
    assert.equal(handled, 0);
  });

  it("rate limits per key", async () => {
    const limiter = new TokenBucketRateLimiter({ tokensPerInterval: 2, intervalMs: 60_000, burst: 2, now: () => 0 });
    const run = () => executeRequest({ type: "t", rawPayload: { uid: "a" }, messageContext: { id: 1 } as any, spec: { ...spec, rateLimit: limiter }, logger, rateLimitKey: "user-1", resolveContext: async () => ({}) });
    assert.equal((await run())!.ok, true);
    assert.equal((await run())!.ok, true);
    assert.deepEqual(await run(), { ok: false, error: "RATE_LIMIT" });
  });

  it("bounds arrays and numbers", () => {
    assert.equal(StageStartSchema.safeParse({ regionId: "r", stageId: "s", difficulty: "Easy", uidsInSlots: Array(11).fill("u"), leaderSlotIndex: 0 }).success, false);
    assert.equal(ShopPurchaseSchema.safeParse({ itemId: "i", expectedPrice: { amount: 1, currencyId: "gem", extra: 1 } }).success, false);
  });
});

describe("Security: access tokens", () => {
  const tokens = new JwtAccessTokenService(SECRET, 10);

  it("accepts its own tokens only while the session holds the same jti", async () => {
    const sessions = new MemorySessions();
    const authenticator = new AccessAuthenticator(tokens, sessions);
    const signed = tokens.sign("user-1", "alice", "device-1");
    await sessions.setSession("user-1", "device-1", { username: "alice", level: 1, nickname: "alice", iconId: null, accessJti: signed.accessJti });
    assert.equal((await authenticator.authenticate(signed.token))?.userId, "user-1");

    const rotated = tokens.sign("user-1", "alice", "device-1");
    await sessions.setSession("user-1", "device-1", { username: "alice", level: 1, nickname: "alice", iconId: null, accessJti: rotated.accessJti });
    assert.equal(await authenticator.authenticate(signed.token), null, "old token revoked by rotation");

    await sessions.deleteSession("user-1", "device-1");
    assert.equal(await authenticator.authenticate(rotated.token), null, "logout revokes the token");
  });

  it("rejects unsigned, foreign-audience and wrong-algorithm tokens", () => {
    const unsigned = jwt.sign({ sub: "u", username: "x", deviceId: "d" }, "", { algorithm: "none" as any, jwtid: "j", issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    const foreign = jwt.sign({ sub: "u", username: "x" }, SECRET, { jwtid: "j", issuer: JWT_ISSUER, audience: "someone-else" });
    const hs512 = jwt.sign({ sub: "u", username: "x" }, SECRET, { algorithm: "HS512", jwtid: "j", issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    const expired = jwt.sign({ sub: "u", username: "x", exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { jwtid: "j", issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    for (const token of [unsigned, foreign, hs512, expired]) assert.equal(tokens.verify(token), null);
  });
});

describe("Security: admin API", () => {
  function call(apiKey: string, header?: string) {
    let status = 200;
    let nextCalled = false;
    const res: any = { status: (code: number) => { status = code; return res; }, json: () => res };
    requireAdminKey(apiKey)({ header: () => header } as any, res, () => { nextCalled = true; });
    return { status, nextCalled };
  }

  it("is disabled without a key and requires the exact key otherwise", () => {
    assert.deepEqual(call("", "anything"), { status: 404, nextCalled: false });
    assert.deepEqual(call("k".repeat(24), "wrong"), { status: 401, nextCalled: false });
    assert.deepEqual(call("k".repeat(24), "k".repeat(24)), { status: 200, nextCalled: true });
    assert.equal(adminKeyMatches("", ""), false);
  });
});

describe("Security: errors", () => {
  it("serializes AppErrors without stack traces", () => {
    const body = new AppError("ECON_INSUFFICIENT_FUNDS", { extra: { need: 5 } }).toResponse();
    assert.deepEqual(body, { ok: false, error: "ECON_INSUFFICIENT_FUNDS", extra: { need: 5 } });
  });
});
