import fs from "fs";
import * as fsp from "fs/promises";
import path from "path";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";

export type CurrencyCfg = {
  id: string;
  initialAmount: number;
  rechargeable: boolean;
  rechargeAmount: number;
  rechargeIntervalSeconds: number;
  rechargeOffline: boolean;
  hasCap: boolean;
  baseCap: number;
  capScalesWithLevel: boolean;
  capIncrementsByLevel: number[];
  canOverflowAboveCap: boolean;
  canFuse?: boolean;
  fusionTargetCurrencyId?: string;
  fusionRequiredAmount?: number;
  fusionExtraCostCurrencyId?: string;
  fusionExtraCostAmount?: number;
};

export type CurrencyCatalog = { currencies: CurrencyCfg[] };

let _catalog: CurrencyCatalog = { currencies: [] };

/** `currencies.json` (Unity export): a root array of currency definitions. */
function normalizeCurrencies(rawText: string): CurrencyCatalog {
  const parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed)) {
    console.warn("[CurrencyConfig] invalid format; expected a root array of currencies");
    return { currencies: [] };
  }
  return { currencies: parsed as CurrencyCfg[] };
}

/** Load once on boot using lenient fallbacks. */
export function loadCurrencyCatalogOnce(): CurrencyCatalog {
  return loadInternal(true);
}

/** Reload from disk after an import event. */
export function reloadCurrencyCatalog(): CurrencyCatalog {
  return loadInternal(false);
}

/** Reload from a specific file path (used by ZIP import). */
export async function reloadCurrencyCatalogFromFile(filePath: string): Promise<CurrencyCatalog> {
  const raw = await fsp.readFile(filePath, "utf8");
  _catalog = normalizeCurrencies(raw);
  console.log("[CurrencyConfig] reloaded from file:", filePath, "items:", _catalog.currencies.length);
  return _catalog;
}

function loadInternal(warnIfMissing: boolean): CurrencyCatalog {
  try {
    const chosen = locateCatalogFile("currencies.json");
    if (!chosen) {
      const msg = "[CurrencyConfig] currencies file not found in any of: " + JSON.stringify(configDirs());
      warnIfMissing ? console.warn(msg) : console.log(msg);
      _catalog = _catalog?.currencies ? _catalog : { currencies: [] };
      return _catalog;
    }

    const raw = fs.readFileSync(chosen, "utf8");
    _catalog = normalizeCurrencies(raw);
    console.log("[CurrencyConfig] loaded", _catalog.currencies.length, "currencies from:", chosen);
    return _catalog;
  } catch (e) {
    console.error("[CurrencyConfig] load error:", e);
    _catalog = { currencies: [] };
    return _catalog;
  }
}

export function getCurrencyCatalog(): CurrencyCatalog {
  return _catalog?.currencies ? _catalog : { currencies: [] };
}

export function getCurrencyById(id: string): CurrencyCfg | undefined {
  return getCurrencyCatalog().currencies.find((x) => x.id === id);
}

export function maxCapFor(cfg: CurrencyCfg, accountLevel: number): number {
  if (!cfg.hasCap) return Number.MAX_SAFE_INTEGER;
  let cap = cfg.baseCap || 0;
  if (cfg.capScalesWithLevel && cfg.capIncrementsByLevel?.length) {
    const count = Math.max(0, Math.min(cfg.capIncrementsByLevel.length, Math.max(0, accountLevel - 1)));
    for (let i = 0; i < count; i++) cap += (cfg.capIncrementsByLevel[i] || 0);
  }
  return cap;
}

