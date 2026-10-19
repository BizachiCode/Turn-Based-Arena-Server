import type { DungeonKind } from "../../config/DungeonCatalog.js";

export type DungeonHallStatusDto = {
  regionId: string;
  kind: DungeonKind;
  elementId: string;
  /** Weekdays the hall opens (0 = Sunday .. 6 = Saturday). */
  openDays: number[];
  /** Open on the current game day. */
  open: boolean;
  minAccountLevel: number;
  /** The player's account level is below `minAccountLevel`. */
  levelLocked: boolean;
};

/** `dungeon/status` reply. */
export type DungeonStatusResponseDto = {
  ok: true;
  serverTimeUnix: number;
  resetHourUtc: number;
  /** When today's schedule ends (next daily reset). */
  nextResetAtUnix: number;
  halls: DungeonHallStatusDto[];
};
