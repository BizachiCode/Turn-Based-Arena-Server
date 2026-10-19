// GM panel "Config": read-only view of the catalogs the server loaded (`game_config/*.json`): size, modification
// time, version marker and entry counts. Importing stays on `POST /admin/config/import`.

import * as fsp from "node:fs/promises";
import path from "node:path";

import type { AdminConfigFile } from "./admin-moderation.ports.js";

type CachedSummary = { mtimeMs: number; bytes: number; version: string | null; counts: Record<string, number> };

const MAX_COUNT_KEYS = 12;
const VERSION_KEYS = ["version", "schemaVersion", "exportedAt", "generatedAt", "updatedAt"];

export class AdminConfigService {
  private readonly cache = new Map<string, CachedSummary>();

  constructor(private readonly configDir: string) {}

  async files(): Promise<AdminConfigFile[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.configDir);
    } catch {
      return [];
    }
    const catalogs = names.filter((name) => name.endsWith(".json")).sort();
    const rows = await Promise.all(catalogs.map((name) => this.describe(name)));
    return rows.filter((row): row is AdminConfigFile => row !== null);
  }

  private async describe(name: string): Promise<AdminConfigFile | null> {
    const file = path.join(this.configDir, name);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return null;
      let summary = this.cache.get(name);
      if (!summary || summary.mtimeMs !== stat.mtimeMs || summary.bytes !== stat.size) {
        summary = { mtimeMs: stat.mtimeMs, bytes: stat.size, ...summarize(await fsp.readFile(file, "utf8")) };
        this.cache.set(name, summary);
      }

      return {
        file: name,
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
        version: summary.version,
        counts: summary.counts,
      };
    } catch {
      return null;
    }
  }
}

function summarize(text: string): { version: string | null; counts: Record<string, number> } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { version: null, counts: {} };
  }
  if (Array.isArray(data)) return { version: null, counts: { items: data.length } };
  if (!data || typeof data !== "object") return { version: null, counts: {} };

  const record = data as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Object.keys(counts).length >= MAX_COUNT_KEYS) break;
    if (Array.isArray(value)) counts[key] = value.length;
    else if (value && typeof value === "object") counts[key] = Object.keys(value).length;
  }
  const marker = VERSION_KEYS.map((key) => record[key]).find((value) => typeof value === "string" || typeof value === "number");
  return { version: marker === undefined ? null : String(marker), counts };
}
