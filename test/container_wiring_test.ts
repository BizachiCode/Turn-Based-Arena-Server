import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { configureHttp } from "../src/app/http";
import { createContainer } from "../src/app/container";
import { env } from "../src/config/env";
import { serverRuntimeState } from "../src/infrastructure/runtime/server-runtime-state";
import { expressTrustProxySetting } from "../src/shared/rooms/client-address";

function containerWith(overrides: Partial<typeof env> = {}) {
  // Only wiring is checked: the repositories never run, so stubs stand in for the database and Redis.
  return createContainer({ database: {} as never, redis: {} as never, runtime: serverRuntimeState, env: { ...env, ...overrides } as typeof env });
}

async function remoteAddress(app: express.Application, headers: Record<string, string>): Promise<string> {
  app.get("/whoami", (req, res) => { res.json({ ip: req.ip }); });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/whoami`, { headers });
    return ((await response.json()) as { ip: string }).ip;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("Composition root wiring", () => {
  it("hands the shared limiters to the chat rooms", () => {
    const container = containerWith();
    const chat = new container.rooms.chat() as unknown as { deps: Record<string, unknown> };
    const guildChat = new container.rooms.guildChat() as unknown as { deps: Record<string, unknown> };
    assert.equal(chat.deps.queryLimiter, container.limiters.query);
    assert.equal(guildChat.deps.queryLimiter, container.limiters.query);
    assert.equal(guildChat.deps.sendLimiter, container.limiters.chatSend);
  });

  it("exposes the log services the GM panel and the boot need", () => {
    const container = containerWith();
    assert.ok(container.logStore);
    assert.ok(container.services.adminLogs);
    assert.ok(container.jobs.retention);
  });
});

describe("Express client address (TRUST_PROXY / TRUSTED_PROXIES)", () => {
  it("derives the Express setting from the same options as the rooms", () => {
    assert.equal(expressTrustProxySetting({ trustProxy: false, trustedProxies: ["10.0.0.2"] }), false);
    assert.equal(expressTrustProxySetting({ trustProxy: true, trustedProxies: [] }), true);
    assert.deepEqual(expressTrustProxySetting({ trustProxy: true, trustedProxies: ["10.0.0.2", "::1"] }), ["10.0.0.2", "::1"]);
  });

  it("configureHttp applies it to the app", () => {
    const off = express();
    configureHttp(off, containerWith({ trustProxy: false, trustedProxies: [] }));
    assert.equal(off.get("trust proxy"), false);

    const listed = express();
    configureHttp(listed, containerWith({ trustProxy: true, trustedProxies: ["127.0.0.1"] }));
    assert.deepEqual(listed.get("trust proxy"), ["127.0.0.1"]);
  });

  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const forwarded = { "x-forwarded-for": "203.0.113.9" };
    const untrusted = express();
    untrusted.set("trust proxy", expressTrustProxySetting({ trustProxy: false, trustedProxies: [] }));
    assert.match(await remoteAddress(untrusted, forwarded), /127\.0\.0\.1$/);

    const trusted = express();
    trusted.set("trust proxy", expressTrustProxySetting({ trustProxy: true, trustedProxies: ["127.0.0.1"] }));
    assert.equal(await remoteAddress(trusted, forwarded), "203.0.113.9");

    const otherProxy = express();
    otherProxy.set("trust proxy", expressTrustProxySetting({ trustProxy: true, trustedProxies: ["10.9.9.9"] }));
    assert.match(await remoteAddress(otherProxy, forwarded), /127\.0\.0\.1$/, "a peer that is not a listed proxy cannot set the address");
  });
});
