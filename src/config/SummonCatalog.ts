import fs from "fs";
import * as fsp from "fs/promises";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";

/* ---------- type ---------- */
/** `weight` is the effective weight (Rate Up already applied); `rateUp` is informational. */
export type SummonEntry = { characterId: string; weight: number; rateUp?: boolean };
export type SummonPool  = { id: string; weight: number; minStars: number; maxStars: number; entries: SummonEntry[] };
// src/config/SummonCatalog.ts 
export type SummonScroll = {
  id: string;
  name?: string;
  /**
   * Rollable table. The Unity exporter writes only the eligible entries (star range of the scroll and the pool, allowed
   * elements) with their effective weights (Rate Up multiplier applied), so the server rolls what the Offline backend rolls.
   */
  pools: SummonPool[];
  /** Currency spent per summon (empty: resolved from the scroll id, see `resolveSummonEconomy`). */
  currencyId?: string;
  /** Price of a single summon. */
  costPerSummon?: number;
  /** Price of the multi summon (0 = no multi offer). */
  tenPlusOneCost?: number;
  /** Characters granted by the multi summon (11 = 10+1, 1 = disabled). */
  multiGive?: number;
  /** Banner window (unix seconds, 0/absent = open-ended): summons outside it fail with `SCROLL_NOT_AVAILABLE`. */
  availableFromUnix?: number;
  availableUntilUnix?: number;
};

/** True when the scroll can be used at `nowMs` (banner window, both ends optional). */
export function isSummonScrollAvailable(scroll: SummonScroll, nowMs: number): boolean {
  const from = Number(scroll.availableFromUnix ?? 0);
  const until = Number(scroll.availableUntilUnix ?? 0);
  if (from > 0 && nowMs < from * 1000) return false;
  if (until > 0 && nowMs >= until * 1000) return false;
  return true;
}

/** `summons.json` as exported by the Unity `SummonJsonExporter`. */
export type SummonCatalog = { version?: string; generatedAtUnix?: number; scrolls: SummonScroll[] };

/* ---------- state ---------- */
let _summons: SummonCatalog = { scrolls: [] };

/* ---------- paths ---------- */

/* ---------- normalize ---------- */
function normalizeSummons(rawText: string): SummonCatalog {
  const parsed = JSON.parse(rawText);
  if (!parsed || !Array.isArray(parsed.scrolls)) {
    console.warn("[SummonCatalog] invalid format; expected { version, generatedAtUnix, scrolls: [] }");
    return { scrolls: [] };
  }
  return {
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
    ...(Number.isFinite(parsed.generatedAtUnix) ? { generatedAtUnix: parsed.generatedAtUnix } : {}),
    scrolls: parsed.scrolls as SummonScroll[],
  };
}

/* ---------- API ---------- */
export function loadSummonCatalogOnce(): SummonCatalog { return loadInternal(true); }
export function reloadSummonCatalog(): SummonCatalog   { return loadInternal(false); }

export async function reloadSummonCatalogFromFile(filePath: string): Promise<SummonCatalog> {
  const raw = await fsp.readFile(filePath, "utf8");
  _summons = normalizeSummons(raw);
  console.log("[SummonCatalog] reloaded from file:", filePath, "scrolls:", _summons.scrolls.length);
  return _summons;
}

function loadInternal(warnIfMissing: boolean): SummonCatalog {
  try {
    const chosen = locateCatalogFile("summons.json");
    if (!chosen) {
      const msg = "[SummonCatalog] summons file not found in any of: " + JSON.stringify(configDirs());
      warnIfMissing ? console.warn(msg) : console.log(msg);
      _summons = _summons?.scrolls ? _summons : { scrolls: [] };
      return _summons;
    }

    const raw = fs.readFileSync(chosen, "utf8");
    _summons = normalizeSummons(raw);
    console.log("[SummonCatalog] loaded", _summons.scrolls.length, "scrolls from:", chosen);
    return _summons;
  } catch (e) {
    console.error("[SummonCatalog] load error:", e);
    _summons = { scrolls: [] };
    return _summons;
  }
}

export function getSummonCatalog(): SummonCatalog { return _summons?.scrolls ? _summons : { scrolls: [] }; }
export function getSummonById(id: string): SummonScroll | undefined {
  return getSummonCatalog().scrolls.find((s) => s.id === id);
}

