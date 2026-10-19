import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { AddressAllowList, AdminFailureTracker, createAdminGuard } from "../src/modules/admin/admin-guard";

const KEY = "unit-test-admin-key-0123456789";

describe("Admin guard: address allowlist (ADMIN_ALLOWED_IPS)", () => {
  it("matches exact IPv4 / IPv6 addresses and CIDR ranges", () => {
    const list = new AddressAllowList(["203.0.113.7", "10.1.0.0/16", "2001:db8::/32", "::1"]);
    assert.equal(list.allows("203.0.113.7"), true);
    assert.equal(list.allows("203.0.113.8"), false);
    assert.equal(list.allows("10.1.200.3"), true);
    assert.equal(list.allows("10.2.0.1"), false);
    assert.equal(list.allows("2001:db8:1::5"), true);
    assert.equal(list.allows("2001:db9::1"), false);
    assert.equal(list.allows("::1"), true);
  });

  it("treats IPv4-mapped IPv6 addresses as the IPv4 address and `localhost` as both loopbacks", () => {
    const list = new AddressAllowList(["10.0.0.0/8", "localhost"]);
    assert.equal(list.allows("::ffff:10.4.4.4"), true);
    assert.equal(list.allows("127.0.0.1"), true);
    assert.equal(list.allows("::ffff:127.0.0.1"), true);
    assert.equal(list.allows("::1"), true);
    assert.equal(list.allows("::2"), false);
  });

  it("never allows an unknown or malformed address", () => {
    const list = new AddressAllowList(["0.0.0.0/0", "::/0"]);
    assert.equal(list.allows(undefined), false);
    assert.equal(list.allows(null), false);
    assert.equal(list.allows(""), false);
    assert.equal(list.allows("not-an-ip"), false);
    assert.equal(list.allows("1.2.3.4"), true);
  });

  it("refuses a malformed entry at boot instead of silently allowing everything", () => {
    assert.throws(() => new AddressAllowList(["10.0.0.0/33"]), /prefix/);
    assert.throws(() => new AddressAllowList(["10.0.0.0/abc"]), /prefix/);
    assert.throws(() => new AddressAllowList(["example.com"]), /not an IP/);
    assert.throws(() => new AddressAllowList(["2001:db8::/129"]), /prefix/);
    assert.equal(new AddressAllowList([]).size, 0);
  });
});

describe("Admin guard: failed key tracker", () => {
  it("locks an address out after the configured number of wrong keys", () => {
    let now = 1_000_000;
    const tracker = new AdminFailureTracker(3, 60, () => now);
    assert.equal(tracker.fail("1.2.3.4"), false);
    assert.equal(tracker.fail("1.2.3.4"), false);
    assert.equal(tracker.lockedFor("1.2.3.4"), 0);
    assert.equal(tracker.fail("1.2.3.4"), true, "the third failure starts the lockout");
    assert.equal(tracker.lockedFor("1.2.3.4"), 60);
    assert.equal(tracker.lockedFor("5.6.7.8"), 0, "other addresses are not affected");
    now += 59_000;
    assert.equal(tracker.lockedFor("1.2.3.4"), 1);
    now += 2_000;
    assert.equal(tracker.lockedFor("1.2.3.4"), 0, "the lockout ends by itself");
  });

  it("forgets old failures after the window and clears them on a correct key", () => {
    let now = 5_000_000;
    const tracker = new AdminFailureTracker(3, 60, () => now);
    tracker.fail("9.9.9.9");
    tracker.fail("9.9.9.9");
    now += 61_000;
    assert.equal(tracker.fail("9.9.9.9"), false, "two old failures plus one new one do not lock");
    tracker.fail("9.9.9.9");
    tracker.succeed("9.9.9.9");
    assert.equal(tracker.fail("9.9.9.9"), false);
    assert.equal(tracker.fail("9.9.9.9"), false);
    assert.equal(tracker.fail("9.9.9.9"), true, "the counter restarted after the success");
  });

  it("counts an IPv6 client by its /64 and treats IPv4-mapped addresses as IPv4", () => {
    const tracker = new AdminFailureTracker(2, 60, () => 1);
    assert.equal(AdminFailureTracker.keyOf("2001:db8:0:1:aaaa::1"), AdminFailureTracker.keyOf("2001:db8:0:1:bbbb::2"));
    assert.notEqual(AdminFailureTracker.keyOf("2001:db8:0:1::1"), AdminFailureTracker.keyOf("2001:db8:0:2::1"));
    assert.equal(AdminFailureTracker.keyOf("::ffff:1.2.3.4"), "1.2.3.4");
    tracker.fail("2001:db8:0:1:aaaa::1");
    assert.equal(tracker.fail("2001:db8:0:1:bbbb::2"), true, "rotating inside one /64 does not reset the counter");
    assert.ok(tracker.lockedFor("2001:db8:0:1:cccc::3") > 0);
  });

  it("does not grow without bound under a flood of addresses", () => {
    const tracker = new AdminFailureTracker(5, 600, () => 1);
    for (let i = 0; i < 12_000; i++) tracker.fail(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    assert.ok(tracker.trackedAddresses <= 10_001, `tracked ${tracker.trackedAddresses}`);
  });
});

async function withApp(options: Partial<Parameters<typeof createAdminGuard>[0]>, run: (call: (path: string, init?: RequestInit & { ip?: string }) => Promise<{ status: number; body: any; retryAfter: string | null }>, guard: ReturnType<typeof createAdminGuard>) => Promise<void>) {
  const guard = createAdminGuard({ apiKey: KEY, allowedIps: [], maxFailures: 3, lockoutSeconds: 60, ...options });
  const app = express();
  // The tests choose the "client address" with a header; production uses the socket / trust proxy setting.
  app.use((req, _res, next) => {
    const forced = req.header("x-test-ip");
    if (forced) Object.defineProperty(req, "ip", { value: forced });
    next();
  });
  app.use("/admin", guard.allowlist, guard.requireKey);
  app.get("/admin/data", (_req, res) => res.json({ ok: true, secret: "data" }));
  app.use("/monitor", guard.allowlist, guard.requireBasicAuth, (_req, res) => res.send("monitor"));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = async (path: string, init: RequestInit & { ip?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.ip) headers.set("x-test-ip", init.ip);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, retryAfter: res.headers.get("retry-after") };
  };
  try {
    await run(call, guard);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("Admin guard: express handlers", () => {
  it("accepts the right key in the header and refuses missing, wrong and query-string keys", async () => {
    await withApp({ maxFailures: 50 }, async (call) => {
      assert.equal((await call("/admin/data", { headers: { "x-config-api-key": KEY } })).status, 200);
      assert.equal((await call("/admin/data")).status, 401);
      assert.equal((await call("/admin/data", { headers: { "x-config-api-key": "nope" } })).status, 401);
      assert.equal((await call(`/admin/data?x-config-api-key=${KEY}&key=${KEY}`)).status, 401);
      assert.equal((await call("/admin/data", { headers: { authorization: `Bearer ${KEY}`, cookie: `x-config-api-key=${KEY}` } })).status, 401);
      assert.equal((await call("/admin/data", { headers: { "x-config-api-key": KEY.toUpperCase() } })).status, 401);
      assert.equal((await call("/admin/data", { headers: { "x-config-api-key": `${KEY}x` } })).status, 401);
      const refusal = await call("/admin/data");
      assert.deepEqual(refusal.body, { ok: false, error: "UNAUTHORIZED" }, "a refusal carries no data");
    });
  });

  it("locks an address out after repeated wrong keys, even for the right key, with Retry-After", async () => {
    await withApp({ maxFailures: 3, lockoutSeconds: 120 }, async (call) => {
      for (let i = 0; i < 3; i++) assert.equal((await call("/admin/data", { ip: "198.51.100.1", headers: { "x-config-api-key": `wrong-${i}` } })).status, 401);
      const locked = await call("/admin/data", { ip: "198.51.100.1", headers: { "x-config-api-key": KEY } });
      assert.equal(locked.status, 429);
      assert.equal(locked.body.error, "ADMIN_LOCKED");
      assert.ok(Number(locked.retryAfter) > 0 && Number(locked.retryAfter) <= 120);
      assert.equal((await call("/admin/data", { ip: "198.51.100.2", headers: { "x-config-api-key": KEY } })).status, 200, "another address is unaffected");
    });
  });

  it("counts a missing key as a failure and resets the counter on success", async () => {
    await withApp({ maxFailures: 3 }, async (call) => {
      await call("/admin/data", { ip: "198.51.100.3" });
      await call("/admin/data", { ip: "198.51.100.3" });
      assert.equal((await call("/admin/data", { ip: "198.51.100.3", headers: { "x-config-api-key": KEY } })).status, 200);
      await call("/admin/data", { ip: "198.51.100.3" });
      await call("/admin/data", { ip: "198.51.100.3" });
      assert.equal((await call("/admin/data", { ip: "198.51.100.3", headers: { "x-config-api-key": KEY } })).status, 200, "two failures after a success are below the limit");
    });
  });

  it("answers 404 outside ADMIN_ALLOWED_IPS before looking at the key", async () => {
    await withApp({ allowedIps: ["203.0.113.0/24"] }, async (call) => {
      const outside = await call("/admin/data", { ip: "198.51.100.9", headers: { "x-config-api-key": KEY } });
      assert.equal(outside.status, 404);
      assert.deepEqual(outside.body, { ok: false, error: "NOT_FOUND" });
      assert.equal((await call("/admin/data", { ip: "203.0.113.5", headers: { "x-config-api-key": KEY } })).status, 200);
      assert.equal((await call("/admin/data", { ip: "203.0.113.5" })).status, 401);
    });
  });

  it("is disabled (404) when no key is configured, whatever is sent", async () => {
    await withApp({ apiKey: "" }, async (call) => {
      assert.equal((await call("/admin/data", { headers: { "x-config-api-key": "" } })).status, 404);
      assert.equal((await call("/admin/data", { headers: { "x-config-api-key": "anything" } })).status, 404);
    });
  });

  it("protects the dev monitor with HTTP Basic (any user, the admin key as password) and the same lockout", async () => {
    await withApp({ maxFailures: 2 }, async (call) => {
      const first = await call("/monitor");
      assert.equal(first.status, 401, "a browser is asked for credentials");
      const basic = (password: string) => ({ authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` });
      assert.equal((await call("/monitor", { headers: basic(KEY) })).status, 200);
      assert.equal((await call("/monitor", { ip: "198.51.100.20", headers: basic("bad1") })).status, 401);
      assert.equal((await call("/monitor", { ip: "198.51.100.20", headers: basic("bad2") })).status, 401);
      assert.equal((await call("/monitor", { ip: "198.51.100.20", headers: basic(KEY) })).status, 429);
      assert.equal((await call("/admin/data", { ip: "198.51.100.20", headers: { "x-config-api-key": KEY } })).status, 429, "wrong keys on any admin surface share one counter");
    });
  });
});
