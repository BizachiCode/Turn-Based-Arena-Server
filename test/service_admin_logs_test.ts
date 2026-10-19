import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { likePattern } from "../src/modules/admin/admin-logs.repository";
import type { AdminLogLevelCounts, AdminLogQuery, AdminLogRow, AdminLogsRepository } from "../src/modules/admin/admin-logs.ports";
import { AdminLogsService } from "../src/modules/admin/admin-logs.service";
import { registerOpsRoutes, type RuntimeAdminOpsDeps } from "../src/modules/admin/runtime-admin-ops.routes";
import { FixedClock } from "../src/shared/kernel/clock";
import { LogSink } from "../src/shared/log/log-sink";
import type { LogRecord, LogStore } from "../src/shared/log/log-types";

const T0 = Date.UTC(2026, 9, 17, 12);

class FakeRepo implements AdminLogsRepository {
  queries: AdminLogQuery[] = [];
  rows: AdminLogRow[] = Array.from({ length: 5 }, (_v, i) => ({
    id: 5 - i, time: new Date(T0 - i * 1000).toISOString(), level: i === 0 ? "error" : "info", scope: "Room", message: `row ${5 - i}`, details: null, userId: null, room: null, repeats: 1, pid: 1,
  }));
  failing = false;
  async query(query: AdminLogQuery) {
    this.queries.push(query);
    if (this.failing) throw new Error("db down");
    return this.rows.filter((row) => !query.before || row.id < query.before).slice(0, query.limit);
  }
  async levelCounts(): Promise<AdminLogLevelCounts> {
    if (this.failing) throw new Error("db down");
    return { debug: 0, info: 4, warn: 0, error: 1 };
  }
  async scopes() {
    if (this.failing) throw new Error("db down");
    return [{ scope: "Room", count: 5 }];
  }
}

class NullStore implements LogStore {
  async insertMany(_records: readonly LogRecord[]): Promise<void> {}
}

function setup(attached = true) {
  const clock = new FixedClock(T0);
  const sink = new LogSink({ consoleMode: "none", flushIntervalMs: 60_000, now: () => clock.nowMs() });
  if (attached) sink.attachStore(new NullStore());
  const repo = new FakeRepo();
  const service = new AdminLogsService({ repo, sink, clock, retentionDays: 14 });
  return { sink, repo, service };
}

describe("AdminLogsService", () => {
  it("answers from the database with a paging cursor", async () => {
    const { service, repo } = setup();
    const page = await service.list({ limit: 2 });
    assert.equal(page.source, "database");
    assert.deepEqual(page.entries.map((row) => row.id), [5, 4]);
    assert.equal(page.nextBefore, 4);

    const next = await service.list({ limit: 2, before: page.nextBefore });
    assert.deepEqual(next.entries.map((row) => row.id), [3, 2]);
    const last = await service.list({ limit: 10, before: 2 });
    assert.equal(last.nextBefore, null, "a short page is the end");
    assert.equal(repo.queries[0].levels.length, 0);
  });

  it("passes the filters to the repository", async () => {
    const { service, repo } = setup();
    const from = new Date(T0 - 3600_000);
    await service.list({ levels: ["warn", "error"], scope: "Room", q: "  boom ", from, limit: 50 });
    assert.deepEqual(repo.queries[0], { levels: ["warn", "error"], scope: "Room", q: "boom", from, to: null, before: null, limit: 50 });
  });

  it("falls back to the memory buffer when the database cannot answer", async () => {
    const { service, repo, sink } = setup();
    sink.record("error", "Boot", ["something broke"]);
    repo.failing = true;
    const page = await service.list({ levels: ["error"] });
    assert.equal(page.source, "memory");
    assert.ok(page.entries.some((row) => row.message === "something broke"));
    assert.ok(page.entries.every((row) => row.level === "error"));
  });

  it("reads the memory buffer when no store is attached yet", async () => {
    const { service, repo, sink } = setup(false);
    sink.record("info", "Early", ["booting"]);
    const page = await service.list({ q: "BOOT" });
    assert.equal(page.source, "memory");
    assert.equal(page.entries[0].message, "booting");
    assert.equal(repo.queries.length, 0);
  });

  it("summarises the last 24 hours from the database, or from memory as a fallback", async () => {
    const { service, repo, sink } = setup();
    const ok = await service.summary();
    assert.equal(ok.source, "database");
    assert.deepEqual(ok.counts, { debug: 0, info: 4, warn: 0, error: 1 });
    assert.equal(ok.since, new Date(T0 - 86_400_000).toISOString());
    assert.equal(ok.retentionDays, 14);
    assert.equal(ok.sink.storeAttached, true);

    sink.record("warn", "Mem", ["a"]);
    repo.failing = true;
    const memory = await service.summary();
    assert.equal(memory.source, "memory");
    assert.equal(memory.counts.warn, 1);
    assert.deepEqual(memory.scopes, [{ scope: "Mem", count: 1 }]);
  });

  it("escapes LIKE wildcards in the search text", () => {
    assert.equal(likePattern("50%_off\\x"), "%50\\%\\_off\\\\x%");
  });
});

describe("GM panel logs routes", () => {
  async function withRoutes<T>(service: AdminLogsService, run: (get: (path: string) => Promise<{ status: number; body: any }>) => Promise<T>): Promise<T> {
    const app = express();
    const router = express.Router();
    registerOpsRoutes(router, { logs: service } as unknown as RuntimeAdminOpsDeps);
    app.use("/admin/runtime", router);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      return await run(async (path) => {
        const response = await fetch(`http://127.0.0.1:${port}/admin/runtime${path}`);
        return { status: response.status, body: await response.json() };
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("GET /logs validates the query and returns the page", async () => {
    const { service, repo } = setup();
    await withRoutes(service, async (get) => {
      const ok = await get("/logs?levels=warn,error&scope=Room&q=boom&from=2026-10-17T10:00:00Z&before=5&limit=2");
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
      assert.equal(ok.body.source, "database");
      assert.deepEqual(ok.body.entries.map((row: AdminLogRow) => row.id), [4, 3]);
      const query = repo.queries[repo.queries.length - 1];
      assert.deepEqual([query.levels, query.scope, query.q, query.before, query.limit], [["warn", "error"], "Room", "boom", 5, 2]);
      assert.equal(query.from?.toISOString(), "2026-10-17T10:00:00.000Z");

      for (const bad of ["levels=loud", "limit=0", "limit=500", "before=abc", "from=yesterday", "unknown=1", "scope=" + "x".repeat(49)]) {
        const response = await get(`/logs?${bad}`);
        assert.equal(response.status, 400, bad);
        assert.equal(response.body.error, "INVALID_PAYLOAD", bad);
      }
    });
  });

  it("GET /logs/summary returns the counters", async () => {
    const { service } = setup();
    await withRoutes(service, async (get) => {
      const response = await get("/logs/summary");
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.summary.counts, { debug: 0, info: 4, warn: 0, error: 1 });
      assert.equal(response.body.summary.sink.consoleMode, "none");
    });
  });
});
