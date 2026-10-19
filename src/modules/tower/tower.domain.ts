// Tower seasons (pure). Monthly seasons start on day 1 at `resetHourUtc`; weekly seasons on `weekStartsOn` at
// `resetHourUtc`; "never" towers keep their progress forever.

import type { TowerConfig } from "../../config/TowerCatalog.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");

/** Start (UTC) of the season containing `now`, or null for towers that never reset. */
export function seasonStart(tower: Pick<TowerConfig, "reset" | "resetHourUtc" | "weekStartsOn">, now: Date): Date | null {
  const shifted = new Date(now.getTime() - tower.resetHourUtc * HOUR_MS);
  if (tower.reset === "never") return null;
  if (tower.reset === "monthly") {
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) + tower.resetHourUtc * HOUR_MS);
  }
  const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const back = (shifted.getUTCDay() - tower.weekStartsOn + 7) % 7;
  return new Date(dayStart - back * DAY_MS + tower.resetHourUtc * HOUR_MS);
}

/** Stable key of the season containing `now` (`M:2026-10`, `W:2026-10-05`, `all`). */
export function seasonKey(tower: Pick<TowerConfig, "reset" | "resetHourUtc" | "weekStartsOn">, now: Date): string {
  const start = seasonStart(tower, now);
  if (!start) return "all";
  const day = new Date(start.getTime() - tower.resetHourUtc * HOUR_MS);
  if (tower.reset === "monthly") return `M:${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}`;
  return `W:${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
}

/** Start of the next season (null for towers that never reset). */
export function nextSeason(tower: Pick<TowerConfig, "reset" | "resetHourUtc" | "weekStartsOn">, now: Date): Date | null {
  const start = seasonStart(tower, now);
  if (!start) return null;
  if (tower.reset === "weekly") return new Date(start.getTime() + 7 * DAY_MS);
  const day = new Date(start.getTime() - tower.resetHourUtc * HOUR_MS);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1) + tower.resetHourUtc * HOUR_MS);
}

export type TowerGateFailure = { code: "TOWER_LEVEL_LOCKED" | "TOWER_FLOOR_LOCKED" | "TOWER_FLOOR_CLEARED"; message: string; requiredLevel?: number };

/**
 * Entry rule of a floor: the account level, then floors are climbed in order once per season (`floorIndex` must be the
 * next floor; earlier floors are already cleared this season).
 */
export function evaluateTowerGate(tower: TowerConfig, floorIndex: number, clearedFloors: number, accountLevel: number): TowerGateFailure | null {
  if (accountLevel < tower.minAccountLevel) {
    return { code: "TOWER_LEVEL_LOCKED", message: "Account level too low.", requiredLevel: tower.minAccountLevel };
  }
  if (floorIndex < clearedFloors) return { code: "TOWER_FLOOR_CLEARED", message: "Floor already cleared this season." };
  if (floorIndex > clearedFloors) return { code: "TOWER_FLOOR_LOCKED", message: "Clear the previous floor first." };
  return null;
}
