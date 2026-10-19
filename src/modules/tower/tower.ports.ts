import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Floors cleared per player, tower and season (`user_tower_progress`). */
export interface TowerProgressRepository {
  /** Floors cleared this season (0 when none). */
  getCleared(userId: string, regionId: string, seasonKey: string, session?: DbSession): Promise<number>;
  /** Locks the row (created with 0 when missing) and returns the floors cleared this season. */
  lockCleared(userId: string, regionId: string, seasonKey: string, session: DbSession): Promise<number>;
  setCleared(userId: string, regionId: string, seasonKey: string, floors: number, session: DbSession): Promise<void>;
  /** Drops the rows of seasons other than the current ones (`keep` = region → season). */
  deleteOtherSeasons(userId: string, keep: Map<string, string>): Promise<void>;
}

/** Result of recording a won floor: `applies` = the region is a tower; `firstThisSeason` drives the first-clear rewards. */
export type SeasonalClear = { applies: boolean; firstThisSeason: boolean };

/** Per-season first clears used by the battle rewards (towers). */
export interface SeasonalClearRecorder {
  recordClear(session: DbSession, userId: string, regionId: string, stageId: string): Promise<SeasonalClear>;
}
