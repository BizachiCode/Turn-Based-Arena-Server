// Dungeon rules (pure): weekday schedule and account level gate of each hall.

import type { DungeonConfig, DungeonHall } from "../../config/DungeonCatalog.js";
import { gameWeekday, nextGameDay } from "../../shared/kernel/daily-reset.js";

export type DungeonGateFailure = { code: "DUNGEON_CLOSED" | "DUNGEON_LEVEL_LOCKED"; message: string };

export function findHall(config: DungeonConfig, regionId: string): DungeonHall | undefined {
  return config.halls.find((hall) => hall.regionId === regionId);
}

/** True when the hall is open on the game day containing `now`. */
export function isHallOpen(hall: DungeonHall, now: Date, resetHourUtc: number): boolean {
  return hall.openDays.includes(gameWeekday(now, resetHourUtc));
}

/** Why a player cannot enter a hall right now (null = allowed). Regions that are not halls are never gated. */
export function evaluateDungeonGate(config: DungeonConfig, regionId: string, accountLevel: number, now: Date): DungeonGateFailure | null {
  const hall = findHall(config, regionId);
  if (!hall) return null;
  if (!isHallOpen(hall, now, config.resetHourUtc)) return { code: "DUNGEON_CLOSED", message: "This dungeon is closed today." };
  if (accountLevel < hall.minAccountLevel) return { code: "DUNGEON_LEVEL_LOCKED", message: `Reach account level ${hall.minAccountLevel} to enter.` };
  return null;
}

/** Next instant the hall's open state can change (the next daily reset). */
export function nextScheduleChange(now: Date, resetHourUtc: number): Date {
  return nextGameDay(now, resetHourUtc);
}
