import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { ServerError } from "@colyseus/core";

import { configureHttp, configureMatchmakingCors, guardMatchmakeErrorCodes, installRequestGuard, jsonErrorHandler, jsonNotFound, restrictedCors, securityHeaders } from "../src/app/http";
import { createContainer } from "../src/app/container";
import { env } from "../src/config/env";
import { serverRuntimeState } from "../src/infrastructure/runtime/server-runtime-state";

const KEY = "unit-test-admin-key-0123456789";

function containerWith(overrides: Partial<typeof env> = {}) {
  return createContainer({ database: {} as never, redis: {} as never, runtime: serverRuntimeState, env: { ...env, configApiKey: KEY, adminAllowedIps: [], adminMaxFailedAttempts: 50, ...overrides } as typeof env });
}

async function serve(server: http.Server, run: (base: string) => Promise<void>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withApp(overrides: Partial<typeof env>, run: (base: string) => Promise<void>) {
  const app = express();
  configureHttp(app, containerWith(overrides));
  await serve(http.createServer(app), run);
}

const authed = { "x-config-api-key": KEY };

describe("Http hardening: Express app", () => {
  it("sets the security headers, a default CSP and no x-powered-by on every answer", async () => {
    await withApp({}, async (base) => {
      for (const path of ["/health", "/nope", "/admin/runtime/status"]) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
        assert.equal(res.headers.get("x-frame-options"), "DENY", path);
        assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
        assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/, path);
        assert.ok(res.headers.get("permissions-policy"), path);
        assert.equal(res.headers.get("x-powered-by"), null, path);
      }
      assert.equal((await fetch(`${base}/admin/runtime/status`)).headers.get("cache-control"), "no-store");
    });
  });

  it("serves the GM panel with a per-response nonce CSP and a matching script tag", async () => {
    await withApp({}, async (base) => {
      const one = await fetch(`${base}/gm`);
      const two = await fetch(`${base}/admin/gm`);
      const csp = one.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce && nonce.length >= 16, csp);
      assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /connect-src 'self'/);
      const html = await one.text();
      assert.ok(html.includes(`<script nonce="${nonce}">`));
      assert.equal(html.match(/<script\b/g)?.length, 1);
      assert.notEqual(/script-src 'nonce-([^']+)'/.exec(two.headers.get("content-security-policy") ?? "")?.[1], nonce);
    });
  });

  it("keeps the panel and the API closed to an address outside ADMIN_ALLOWED_IPS", async () => {
    await withApp({ adminAllowedIps: ["203.0.113.0/24"] }, async (base) => {
      assert.equal((await fetch(`${base}/gm`)).status, 404);
      assert.equal((await fetch(`${base}/admin/runtime/status`, { headers: authed })).status, 404);
      assert.equal((await fetch(`${base}/health`)).status, 200, "public routes are not affected");
    });
  });

  it("answers JSON errors without stack traces or file paths", async () => {
    await withApp({}, async (base) => {
      const notFound = await fetch(`${base}/does/not/exist`);
      assert.equal(notFound.status, 404);
      assert.deepEqual(await notFound.json(), { ok: false, error: "NOT_FOUND" });

      const bad = await fetch(`${base}/admin/runtime/maintenance`, { method: "POST", headers: { ...authed, "content-type": "application/json" }, body: "{bad" });
      const text = await bad.text();
      assert.equal(bad.status, 400);
      assert.deepEqual(JSON.parse(text), { ok: false, error: "INVALID_JSON" });
      assert.doesNotMatch(text, /node_modules|body-parser|\.js:\d+|at /);

      const big = await fetch(`${base}/admin/runtime/maintenance`, { method: "POST", headers: { ...authed, "content-type": "application/json" }, body: JSON.stringify({ message: "x".repeat(200_000) }) });
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { ok: false, error: "PAYLOAD_TOO_LARGE" });
    });
  });

  it("checks the key before it parses a body", async () => {
    await withApp({}, async (base) => {
      const unauthenticated = await fetch(`${base}/admin/runtime/maintenance`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
      assert.equal(unauthenticated.status, 401, "malformed JSON without a key is a 401, so the parser never ran");
      const huge = await fetch(`${base}/admin/config/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(1_000_000) }) });
      assert.equal(huge.status, 401);
    });
  });

  it("refuses method tampering on the admin and public routes", async () => {
    await withApp({}, async (base) => {
      assert.equal((await fetch(`${base}/health`, { method: "DELETE" })).status, 404);
      assert.equal((await fetch(`${base}/gm`, { method: "POST" })).status, 404);
      const override = await fetch(`${base}/admin/runtime/maintenance`, { headers: { ...authed, "x-http-method-override": "POST" } });
      assert.equal(override.status, 404, "GET stays GET: the override header is ignored");
    });
  });

  it("takes no static files: source, env and config paths are 404", async () => {
    await withApp({}, async (base) => {
      for (const path of ["/.env", "/package.json", "/src/index.ts", "/game_config/config.json", "/gm/../.env", "/%2e%2e/.env"]) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 404, path);
      }
    });
  });
});

describe("Http hardening: CORS", () => {
  it("removes CORS headers that were set earlier (Colyseus adds them to every request) unless the origin is listed", async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      next();
    });
    app.use(securityHeaders());
    app.use(restrictedCors(["https://game.example"]));
    app.get("/x", (_req, res) => res.json({ ok: true }));
    await serve(http.createServer(app), async (base) => {
      const foreign = await fetch(`${base}/x`, { headers: { origin: "https://evil.example" } });
      assert.equal(foreign.headers.get("access-control-allow-origin"), null);
      assert.equal(foreign.headers.get("access-control-allow-credentials"), null);
      const listed = await fetch(`${base}/x`, { headers: { origin: "https://game.example" } });
      assert.equal(listed.headers.get("access-control-allow-origin"), "https://game.example");
      assert.equal(listed.headers.get("access-control-allow-credentials"), null);
    });
  });

  it("matchmaking CORS: no origin is allowed by default, only the listed ones otherwise, never credentials", () => {
    const controller = {
      DEFAULT_CORS_HEADERS: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true", "Access-Control-Max-Age": "2592000" } as Record<string, string>,
      getCorsHeaders: (_h: Headers): Record<string, string> => ({ "Access-Control-Allow-Origin": "*" }),
    };
    configureMatchmakingCors([], controller);
    assert.equal("Access-Control-Allow-Origin" in controller.DEFAULT_CORS_HEADERS, false);
    assert.equal("Access-Control-Allow-Credentials" in controller.DEFAULT_CORS_HEADERS, false);
    assert.deepEqual(controller.getCorsHeaders(new Headers({ origin: "https://evil.example" })), {});

    configureMatchmakingCors(["https://game.example"], controller);
    assert.equal(controller.getCorsHeaders(new Headers({ origin: "https://game.example" }))["Access-Control-Allow-Origin"], "https://game.example");
    assert.deepEqual(controller.getCorsHeaders(new Headers({ origin: "https://evil.example" })), {});
    assert.deepEqual(controller.getCorsHeaders(new Headers()), {}, "native clients send no Origin and need no CORS headers");
  });
});

describe("Http hardening: request size guard in front of Colyseus", () => {
  it("answers 413 for an oversized Content-Length without running the handlers, and 411 for a chunked matchmaking body", async () => {
    const server = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      req.resume();
      req.on("end", () => res.end("handled"));
    });
    const seen: string[] = [];
    installRequestGuard(server, { maxBodyBytes: 1000, largerLimits: [{ prefix: "/admin/config/import", maxBytes: 50_000 }] });
    await serve(server, async (base) => {
      const small = await fetch(`${base}/matchmake/joinOrCreate/auth`, { method: "POST", body: "x".repeat(500) });
      assert.equal(small.status, 200);
      assert.equal(small.headers.get("x-content-type-options"), "nosniff", "the baseline headers also reach matchmaking replies");

      const big = await fetch(`${base}/matchmake/joinOrCreate/auth`, { method: "POST", body: "x".repeat(5000) });
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { ok: false, error: "PAYLOAD_TOO_LARGE" });
      assert.deepEqual(seen, ["/matchmake/joinOrCreate/auth"], "the oversized request never reached the handler");

      const upload = await fetch(`${base}/admin/config/import`, { method: "POST", body: "x".repeat(20_000) });
      assert.equal(upload.status, 200, "the config import has its own larger limit");
      const tooBig = await fetch(`${base}/admin/config/import`, { method: "POST", body: "x".repeat(80_000) });
      assert.equal(tooBig.status, 413);

      const chunked = await new Promise<number>((resolve, reject) => {
        const address = server.address() as AddressInfo;
        const req = http.request({ host: "127.0.0.1", port: address.port, method: "POST", path: "/matchmake/joinOrCreate/auth", headers: { "transfer-encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("error", reject);
        req.write("abc");
        req.end();
      });
      assert.equal(chunked, 411);
    });
  });
});

describe("Http hardening: matchmaking error codes", () => {
  it("maps codes that are not valid HTTP statuses to 400 and keeps the original code in the message", async () => {
    const make = (code: unknown) => ({
      invokeMethod: async () => { throw Object.assign(new ServerError(typeof code === "number" ? code : 0, "boom"), { code }); },
    });
    for (const code of [4001, 4401, 0, 99, 600, 1008, "x", undefined]) {
      const controller = make(code);
      guardMatchmakeErrorCodes(controller);
      await assert.rejects(controller.invokeMethod(), (error: ServerError) => error.code === 400 && /boom \(code /.test(error.message), `code ${String(code)}`);
    }
    for (const code of [400, 404, 429, 500]) {
      const controller = make(code);
      guardMatchmakeErrorCodes(controller);
      await assert.rejects(controller.invokeMethod(), (error: ServerError) => error.code === code, `code ${code}`);
    }
    // Colyseus' own 52x codes are replaced by Cloudflare (no CORS header): they leave as regular statuses.
    for (const [code, status] of [[520, 404], [521, 400], [522, 404], [523, 400], [524, 410], [525, 401]] as const) {
      const controller = make(code);
      guardMatchmakeErrorCodes(controller);
      await assert.rejects(controller.invokeMethod(), (error: ServerError) => error.code === status && error.message.includes(`(code ${code})`), `code ${code}`);
    }
    const fine = { invokeMethod: async () => ({ ok: 1 }) };
    guardMatchmakeErrorCodes(fine);
    assert.deepEqual(await fine.invokeMethod(), { ok: 1 });
  });
});

describe("Http hardening: error handler", () => {
  async function answer(error: unknown) {
    const app = express();
    app.get("/boom", (_req, _res, next) => next(error));
    app.use(jsonNotFound);
    app.use(jsonErrorHandler);
    let result = { status: 0, text: "" };
    await serve(http.createServer(app), async (base) => {
      const res = await fetch(`${base}/boom`);
      result = { status: res.status, text: await res.text() };
    });
    return result;
  }

  it("maps parser errors to 400 / 413 / 415 and everything else to a generic 500", async () => {
    assert.equal((await answer(Object.assign(new SyntaxError("Unexpected token"), { type: "entity.parse.failed", status: 400 }))).status, 400);
    assert.equal((await answer(Object.assign(new Error("too large"), { type: "entity.too.large", status: 413 }))).status, 413);
    assert.equal((await answer(Object.assign(new Error("charset"), { type: "charset.unsupported", status: 415 }))).status, 415);
    const internal = await answer(new Error("ER_BAD_FIELD_ERROR: Unknown column 'secret' at D:\\srv\\app.js:10"));
    assert.equal(internal.status, 500);
    assert.deepEqual(JSON.parse(internal.text), { ok: false, error: "SERVER_ERROR" });
    assert.doesNotMatch(internal.text, /ER_BAD_FIELD|secret|app\.js/);
  });
});
