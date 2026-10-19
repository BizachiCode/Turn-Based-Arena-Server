import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { locateCatalogFile } from "../src/config/catalog-file-locator";

describe("Catalog file locator", () => {
  let dir: string;
  const saved = { config: process.env.CONFIG_DIR, admin: process.env.ADMIN_STORAGE_DIR };

  const write = (relative: string, secondsAgo: number) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    const time = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, time, time);
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-locator-"));
    process.env.CONFIG_DIR = dir;
    process.env.ADMIN_STORAGE_DIR = dir;
  });

  afterEach(() => {
    if (saved.config === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = saved.config;
    if (saved.admin === undefined) delete process.env.ADMIN_STORAGE_DIR; else process.env.ADMIN_STORAGE_DIR = saved.admin;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("picks the most recently modified of the exported file and the newest bundle copy", () => {
    const exported = write("homes.json", 60);
    assert.equal(locateCatalogFile("homes.json"), exported);

    const bundled = write("bundle_2026-01-01/homes.json", 30);
    assert.equal(locateCatalogFile("homes.json"), bundled);

    // A fresh export after the import wins over the bundle copy.
    fs.utimesSync(exported, new Date(), new Date());
    assert.equal(locateCatalogFile("homes.json"), exported);
  });

  it("ignores old *.latest.json snapshots", () => {
    const exported = write("homes.json", 60);
    write("homes.latest.json", 0);
    assert.equal(locateCatalogFile("homes.json"), exported);
  });

  it("reads bundle files from a sub path (runes) and returns null when nothing exists", () => {
    assert.equal(locateCatalogFile("missing_catalog.json"), null);

    write("rune_sets.json", 60);
    const bundled = write("bundle_2026-01-01/runes/rune_sets.json", 0);
    assert.equal(locateCatalogFile("rune_sets.json", "runes/rune_sets.json"), bundled);
  });
});
