import fs from "fs";
import * as fsp from "fs/promises";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";

export enum HomeCellFlag {
  Buildable = 1 << 0,
  Blocked = 1 << 1,
  Disabled = 1 << 2,
  Reserved = 1 << 3,
  Water = 1 << 4,
}

export type HomePointCfg = {
  x: number;
  z: number;
};

export type HomeFootprintRotationCfg = {
  rotationIndex: number;
  yawDegrees: number;
  cells: HomePointCfg[];
};

export type HomeProductionKind = "currency" | "unitExp";

/**
 * Production of a building (`homes.json` > buildables > production). Only active blocks are kept by the loader
 * (see `isActiveProduction`): currency producers fill a wallet currency up to `capacity`; unit EXP producers give
 * `amountPerHour` EXP per hour to each of the `unitSlots` stationed monsters, up to `capacity` EXP each.
 */
export type HomeProductionCfg = {
  kind: HomeProductionKind;
  /** Currency kind only (empty for unitExp). */
  currencyId: string;
  /** Currency: units per hour. UnitExp: EXP per hour for each stationed monster. */
  amountPerHour: number;
  /** Currency: max stored amount. UnitExp: max stored EXP per monster. */
  capacity: number;
  /** UnitExp only: stationed monsters (1..10); 0 for currency. */
  unitSlots: number;
};

export const MAX_PRODUCTION_UNIT_SLOTS = 10;

export type HomeBuildableCfg = {
  id: string;
  displayName: string;
  description?: string;
  placeableId?: string;
  kind: string;
  canPurchase: boolean;
  canSpawnAsIslandDefault: boolean;
  canMove: boolean;
  canRemove: boolean;
  isUnique: boolean;
  countsTowardsLimit: boolean;
  maxCount: number;
  unlockLevel: number;
  placeCostCurrencyId?: string;
  placeCostAmount: number;
  removeCostCurrencyId?: string;
  removeCostAmount: number;
  rotationStepDegrees: number;
  menuGroup?: string;
  menuOrder?: number;
  footprints: HomeFootprintRotationCfg[];
  /** Absent = the building produces nothing. */
  production?: HomeProductionCfg;
};

export type HomeIslandCellCfg = {
  x: number;
  z: number;
  flags: number;
};

export type HomeDefaultPlacementCfg = {
  templateInstanceId: string;
  buildableId: string;
  x: number;
  z: number;
  yawDegrees: number;
};

export type HomeIslandCfg = {
  id: string;
  displayName: string;
  unlockedByDefault: boolean;
  /** Account level needed to buy the island (`unlock_island`). */
  unlockLevel: number;
  /** Price of the island; no currency or a non-positive amount = free. */
  unlockCostCurrencyId?: string;
  unlockCostAmount: number;
  /** Display / purchase order of the islands. */
  order: number;
  gridSizeX: number;
  gridSizeZ: number;
  cellSize: number;
  cells: HomeIslandCellCfg[];
  defaultPlacements: HomeDefaultPlacementCfg[];
};

export type HomeCatalog = {
  version: string;
  generatedAtUnix: number;
  defaultIslandId?: string;
  buildables: HomeBuildableCfg[];
  islands: HomeIslandCfg[];
};

let _catalog: HomeCatalog = { version: "1.0", generatedAtUnix: 0, buildables: [], islands: [] };

function normalizePoint(raw: any): HomePointCfg | null {
  if (!raw) return null;
  return {
    x: Number(raw.x ?? 0) | 0,
    z: Number(raw.z ?? 0) | 0,
  };
}

/** Whole number from a config value (non-numbers and non-finite values become 0). */
function wholeNumber(raw: unknown): number {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

/**
 * A production block counts only when its kind is known, `amountPerHour` and `capacity` are positive, a currency
 * producer names its currency and a unit EXP producer has at least one slot. Anything else is treated as absent.
 */
export function isActiveProduction(cfg: HomeProductionCfg | null | undefined): cfg is HomeProductionCfg {
  if (!cfg) return false;
  if (!(cfg.amountPerHour > 0) || !(cfg.capacity > 0)) return false;
  if (cfg.kind === "currency") return (cfg.currencyId ?? "").trim().length > 0;
  if (cfg.kind === "unitExp") return cfg.unitSlots >= 1;
  return false;
}

/** Parses a `production` block; malformed or inactive blocks are treated as absent. */
function normalizeProduction(raw: any): HomeProductionCfg | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const kindText = String(raw.kind ?? "").trim().toLowerCase();
  const kind: HomeProductionKind | null = kindText === "currency" ? "currency" : kindText === "unitexp" ? "unitExp" : null;
  if (!kind) return undefined;

  const production: HomeProductionCfg = {
    kind,
    currencyId: kind === "currency" ? String(raw.currencyId ?? "").trim() : "",
    amountPerHour: wholeNumber(raw.amountPerHour),
    capacity: wholeNumber(raw.capacity),
    unitSlots: kind === "unitExp" ? Math.min(MAX_PRODUCTION_UNIT_SLOTS, wholeNumber(raw.unitSlots)) : 0,
  };
  return isActiveProduction(production) ? production : undefined;
}

function productionOf(entry: any): { production?: HomeProductionCfg } {
  const production = normalizeProduction(entry?.production);
  return production ? { production } : {};
}

function normalizeCatalog(rawText: string): HomeCatalog {
  const parsed = JSON.parse(rawText);
  const buildables = Array.isArray(parsed?.buildables) ? parsed.buildables : [];
  const islands = Array.isArray(parsed?.islands) ? parsed.islands : [];

  return {
    version: String(parsed?.version ?? "1.0"),
    generatedAtUnix: Number(parsed?.generatedAtUnix ?? 0) || 0,
    defaultIslandId: parsed?.defaultIslandId ? String(parsed.defaultIslandId) : undefined,
    buildables: buildables
      .map((entry: any) => ({
        id: String(entry?.id ?? "").trim(),
        displayName: String(entry?.displayName ?? entry?.id ?? "").trim(),
        description: entry?.description ? String(entry.description) : undefined,
        placeableId: entry?.placeableId ? String(entry.placeableId) : undefined,
        kind: String(entry?.kind ?? "Building"),
        canPurchase: Boolean(entry?.canPurchase ?? true),
        canSpawnAsIslandDefault: Boolean(entry?.canSpawnAsIslandDefault ?? true),
        canMove: Boolean(entry?.canMove ?? true),
        canRemove: Boolean(entry?.canRemove ?? true),
        isUnique: Boolean(entry?.isUnique ?? false),
        countsTowardsLimit: Boolean(entry?.countsTowardsLimit ?? true),
        maxCount: Math.max(0, Number(entry?.maxCount ?? 0) | 0),
        unlockLevel: Math.max(0, Number(entry?.unlockLevel ?? 0) | 0),
        placeCostCurrencyId: entry?.placeCostCurrencyId ? String(entry.placeCostCurrencyId) : undefined,
        placeCostAmount: Math.max(0, Number(entry?.placeCostAmount ?? 0) | 0),
        removeCostCurrencyId: entry?.removeCostCurrencyId ? String(entry.removeCostCurrencyId) : undefined,
        removeCostAmount: Math.max(0, Number(entry?.removeCostAmount ?? 0) | 0),
        rotationStepDegrees: Math.max(1, Number(entry?.rotationStepDegrees ?? 90)),
        menuGroup: entry?.menuGroup ? String(entry.menuGroup) : undefined,
        menuOrder: Number(entry?.menuOrder ?? 0) | 0,
        footprints: (Array.isArray(entry?.footprints) ? entry.footprints : []).map((footprint: any) => ({
          rotationIndex: Number(footprint?.rotationIndex ?? 0) | 0,
          yawDegrees: Number(footprint?.yawDegrees ?? 0),
          cells: (Array.isArray(footprint?.cells) ? footprint.cells : [])
            .map(normalizePoint)
            .filter(Boolean) as HomePointCfg[],
        })),
        ...productionOf(entry),
      }))
      .filter((entry: HomeBuildableCfg) => entry.id.length > 0),
    islands: islands
      .map((entry: any) => ({
        id: String(entry?.id ?? "").trim(),
        displayName: String(entry?.displayName ?? entry?.id ?? "").trim(),
        unlockedByDefault: Boolean(entry?.unlockedByDefault ?? true),
        unlockLevel: Math.max(0, Number(entry?.unlockLevel ?? 0) | 0),
        unlockCostCurrencyId: entry?.unlockCostCurrencyId ? String(entry.unlockCostCurrencyId) : undefined,
        unlockCostAmount: Math.max(0, Number(entry?.unlockCostAmount ?? 0) | 0),
        order: Number(entry?.order ?? 0) | 0,
        gridSizeX: Math.max(1, Number(entry?.gridSizeX ?? 1) | 0),
        gridSizeZ: Math.max(1, Number(entry?.gridSizeZ ?? 1) | 0),
        cellSize: Math.max(0.1, Number(entry?.cellSize ?? 1)),
        cells: (Array.isArray(entry?.cells) ? entry.cells : [])
          .map((cell: any) => ({
            x: Number(cell?.x ?? 0) | 0,
            z: Number(cell?.z ?? 0) | 0,
            flags: Number(cell?.flags ?? 0) | 0,
          })),
        defaultPlacements: (Array.isArray(entry?.defaultPlacements) ? entry.defaultPlacements : [])
          .map((placement: any) => ({
            templateInstanceId: String(placement?.templateInstanceId ?? "").trim(),
            buildableId: String(placement?.buildableId ?? "").trim(),
            x: Number(placement?.x ?? 0) | 0,
            z: Number(placement?.z ?? 0) | 0,
            yawDegrees: Number(placement?.yawDegrees ?? 0),
          }))
          .filter((placement: HomeDefaultPlacementCfg) => placement.templateInstanceId.length > 0 && placement.buildableId.length > 0),
      }))
      .filter((entry: HomeIslandCfg) => entry.id.length > 0),
  };
}

function loadInternal(warnIfMissing: boolean): HomeCatalog {
  try {
    const chosen = locateCatalogFile("homes.json");
    if (!chosen) {
      const msg = "[HomeCatalog] homes file not found in any of: " + JSON.stringify(configDirs());
      warnIfMissing ? console.warn(msg) : console.log(msg);
      return _catalog;
    }

    const raw = fs.readFileSync(chosen, "utf8");
    _catalog = normalizeCatalog(raw);
    console.log("[HomeCatalog] loaded", _catalog.buildables.length, "buildables and", _catalog.islands.length, "islands from:", chosen);
    return _catalog;
  } catch (error) {
    console.error("[HomeCatalog] load error:", error);
    _catalog = { version: "1.0", generatedAtUnix: 0, buildables: [], islands: [] };
    return _catalog;
  }
}

export function loadHomeCatalogOnce(): HomeCatalog {
  return loadInternal(true);
}

export function reloadHomeCatalog(): HomeCatalog {
  return loadInternal(false);
}

export async function reloadHomeCatalogFromFile(filePath: string): Promise<HomeCatalog> {
  const raw = await fsp.readFile(filePath, "utf8");
  _catalog = normalizeCatalog(raw);
  console.log("[HomeCatalog] reloaded from file:", filePath, "buildables:", _catalog.buildables.length, "islands:", _catalog.islands.length);
  return _catalog;
}

export function getHomeCatalog(): HomeCatalog {
  return _catalog;
}

export function getHomeBuildableById(id: string): HomeBuildableCfg | undefined {
  return getHomeCatalog().buildables.find((entry) => entry.id === id);
}

export function getHomeIslandById(id: string): HomeIslandCfg | undefined {
  return getHomeCatalog().islands.find((entry) => entry.id === id);
}

export function getNearestFootprintRotation(buildable: HomeBuildableCfg | undefined, yawDegrees: number): HomeFootprintRotationCfg | null {
  if (!buildable || !Array.isArray(buildable.footprints) || buildable.footprints.length === 0) return null;

  const normalizedYaw = ((Number(yawDegrees ?? 0) % 360) + 360) % 360;
  let best: HomeFootprintRotationCfg | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const footprint of buildable.footprints) {
    const delta = Math.abs((((footprint.yawDegrees - normalizedYaw) % 360) + 540) % 360 - 180);
    if (delta < bestDelta) {
      best = footprint;
      bestDelta = delta;
    }
  }

  return best;
}

