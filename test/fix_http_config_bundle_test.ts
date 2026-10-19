import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { z } from "zod";

import { BundleRejectedError, DEFAULT_BUNDLE_LIMITS, assertSafeBundle, createAdminConfigRouter, isHostileEntryName } from "../src/modules/admin/admin-config.routes";
import type { CatalogService } from "../src/modules/catalog/catalog.service";
import { makeZip } from "./support/zip-builder";

const KEY = "unit-test-admin-key-0123456789";
const config = Buffer.from('{"a":1}');

describe("Config bundle: zip inspection before extraction", () => {
  it("flags names that could leave the extraction folder", () => {
    for (const name of ["../x", "..\\x", "a/../../x", "a\\..\\..\\x", "/etc/passwd", "\\share\\x", "C:\\Windows\\x", "C:/x", "x\0y", "", "a".repeat(300)]) {
      assert.equal(isHostileEntryName(name), true, JSON.stringify(name));
    }
    for (const name of ["config.json", "runes/sets.json", "a/b/c.json", "..hidden.json", "a..b/c.json"]) {
      assert.equal(isHostileEntryName(name), false, name);
    }
  });

  it("accepts a normal bundle", () => {
    assert.doesNotThrow(() => assertSafeBundle(makeZip([{ name: "config.json", data: config }, { name: "runes/sets.json", data: Buffer.from("[]"), deflate: true }])));
  });

  it("rejects garbage, empty input and an oversized archive", () => {
    assert.throws(() => assertSafeBundle(Buffer.from("not a zip")), BundleRejectedError);
    assert.throws(() => assertSafeBundle(Buffer.alloc(0)), /Empty/);
    assert.throws(() => assertSafeBundle(makeZip([{ name: "config.json", data: config }]), { ...DEFAULT_BUNDLE_LIMITS, maxZipBytes: 10 }), (error: BundleRejectedError) => error.status === 413);
  });

  it("rejects traversal names, symbolic links and too many entries", () => {
    for (const name of ["../evil.txt", "a/../../evil.txt", "/evil.txt", "C:\\evil.txt", "..\\evil.txt"]) {
      assert.throws(() => assertSafeBundle(makeZip([{ name, data: Buffer.from("x") }, { name: "config.json", data: config }])), /unsafe file name/, name);
    }
    assert.throws(() => assertSafeBundle(makeZip([{ name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }])), /symbolic link/);
    const many = Array.from({ length: 50 }, (_v, i) => ({ name: `f${i}.json`, data: Buffer.from("x") }));
    assert.throws(() => assertSafeBundle(makeZip(many), { ...DEFAULT_BUNDLE_LIMITS, maxEntries: 40 }), /too many entries/);
  });

  it("rejects zip bombs by their declared sizes (nothing is inflated)", () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const limits = { ...DEFAULT_BUNDLE_LIMITS, maxEntryBytes: 4 * 1024 * 1024, maxTotalBytes: 6 * 1024 * 1024 };
    const bomb = makeZip([{ name: "big.bin", data: zeros, deflate: true }]);
    assert.ok(bomb.length < 100_000, "a few KB on the wire");
    assert.throws(() => assertSafeBundle(bomb, limits), (error: BundleRejectedError) => error.status === 413 && /too large/.test(error.message));
    const many = makeZip(Array.from({ length: 4 }, (_v, i) => ({ name: `p${i}.bin`, data: Buffer.alloc(3 * 1024 * 1024), deflate: true })));
    assert.throws(() => assertSafeBundle(many, limits), /expands to too much/);
  });
});

type Calls = { zip: Buffer[]; json: unknown[] };

async function withRouter(service: Partial<CatalogService>, run: (base: string, calls: Calls, audit: string[]) => Promise<void>, limits = {}) {
  const calls: Calls = { zip: [], json: [] };
  const audit: string[] = [];
  const fake = {
    getCurrentConfig: () => ({ version: 1 }),
    importZip: async (zip: Buffer) => { calls.zip.push(zip); return { ok: true, imported: { dir: "x", files: [] } }; },
    importJson: async (body: unknown) => { calls.json.push(body); return { ok: true, saved: {} }; },
    ...service,
  } as unknown as CatalogService;
  const app = express();
  app.use("/admin/config", createAdminConfigRouter({ service: fake, apiKey: KEY, audit: { record: async (entry) => { audit.push(entry.kind); } }, limits }));
  app.use(((error, _req, res, _next) => { res.status((error as { status?: number }).status ?? 500).json({ ok: false, error: "HANDLED" }); }) as express.ErrorRequestHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/config`, calls, audit);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const auth = { "x-config-api-key": KEY };

describe("Config import router", () => {
  it("refuses a request without the key before reading the body", async () => {
    await withRouter({}, async (base, calls) => {
      const res = await fetch(`${base}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
      assert.equal(res.status, 401);
      const zip = await fetch(`${base}/import`, { method: "POST", headers: { "content-type": "application/zip" }, body: makeZip([{ name: "config.json", data: config }]) });
      assert.equal(zip.status, 401);
      assert.deepEqual(calls, { zip: [], json: [] });
      assert.equal((await fetch(`${base}/`)).status, 401);
    });
  });

  it("imports a JSON object and a safe zip, and records both in the audit trail", async () => {
    await withRouter({}, async (base, calls, audit) => {
      const json = await fetch(`${base}/import`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"a":1}' });
      assert.equal(json.status, 200);
      const zip = await fetch(`${base}/import`, { method: "POST", headers: { ...auth, "content-type": "application/zip" }, body: makeZip([{ name: "config.json", data: config }]) });
      assert.equal(zip.status, 200);
      assert.equal(calls.json.length, 1);
      assert.equal(calls.zip.length, 1);
      assert.deepEqual(audit, ["ADMIN_CONFIG_IMPORT", "ADMIN_CONFIG_IMPORT"]);
      assert.equal((await fetch(`${base}/`, { headers: auth })).status, 200);
    });
  });

  it("rejects non-object JSON, oversized JSON and unsupported content", async () => {
    await withRouter({}, async (base, calls) => {
      for (const body of ["[1]", '"s"', "null", "7"]) {
        const res = await fetch(`${base}/import`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
        assert.equal(res.status, 400, body);
      }
      const text = await fetch(`${base}/import`, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "hello" });
      assert.equal(text.status, 415, "only application/json is read as config.json");
      const big = await fetch(`${base}/import`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(2000) }) });
      assert.equal(big.status, 413);
      assert.deepEqual(calls, { zip: [], json: [] });
    }, { maxJsonBytes: 1000 });
  });

  it("rejects hostile and oversized zips without calling the importer", async () => {
    await withRouter({}, async (base, calls) => {
      const send = (body: Buffer<ArrayBuffer>) => fetch(`${base}/import`, { method: "POST", headers: { ...auth, "content-type": "application/zip" }, body });
      assert.equal((await send(Buffer.from("junk"))).status, 400);
      assert.equal((await send(makeZip([{ name: "../x", data: Buffer.from("x") }, { name: "config.json", data: config }]))).status, 400);
      assert.equal((await send(makeZip([{ name: "big.bin", data: Buffer.alloc(3 * 1024 * 1024), deflate: true }]))).status, 413);
      const oversized = await send(Buffer.alloc(5000, 1));
      assert.equal(oversized.status, 413);
      assert.equal(calls.zip.length, 0);
    }, { maxZipBytes: 4000, maxEntryBytes: 1024 * 1024 });
  });

  it("answers importer failures without paths, SQL or stack traces", async () => {
    const failures: Array<[Error, number, RegExp]> = [
      [new z.ZodError([{ code: "custom", path: ["chat", "limit"], message: "Expected number" }]), 400, /chat\.limit: Expected number/],
      [new SyntaxError("Unexpected token } in JSON at position 4"), 400, /not valid JSON/],
      [Object.assign(new Error("ENOENT: no such file, open 'D:\\srv\\game_config\\x.json'"), { code: "ENOENT", path: "D:\\srv\\game_config\\x.json" }), 400, /see the server logs/],
      [new Error("Bundle is missing config.json"), 400, /missing config\.json/],
      [new Error("ER_DBACCESS at /var/lib/mysql/x"), 400, /see the server logs/],
    ];
    for (const [error, status, pattern] of failures) {
      await withRouter({ importJson: async () => { throw error; } }, async (base) => {
        const res = await fetch(`${base}/import`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"a":1}' });
        const text = await res.text();
        assert.equal(res.status, status);
        assert.match(text, pattern);
        assert.doesNotMatch(text, /D:\\|\/var\/lib|ENOENT|ER_DBACCESS|\n\s+at /);
      });
    }
  });
});
