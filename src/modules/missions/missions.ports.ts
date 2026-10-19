import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Progress of one mission in one period (`YYYY-MM-DD` game day, or `all` for achievements). */
export type MissionProgressRow = { missionId: string; periodKey: string; progress: number; claimedAt: Date | null };

/** Persistence port of the daily missions and achievements (`user_mission_progress`). */
export interface MissionRepository {
  listProgress(userId: string, periodKeys: string[], session?: DbSession): Promise<MissionProgressRow[]>;
  /** Adds `amount` to each mission's progress (capped at its target), creating missing rows. */
  addProgress(userId: string, periodKey: string, missions: Array<{ missionId: string; target: number }>, amount: number): Promise<void>;
  /** Raises each mission's progress to `value` (capped at its target; never lowers it). */
  raiseProgress(userId: string, periodKey: string, missions: Array<{ missionId: string; target: number }>, value: number): Promise<void>;
  /** Creates the row (progress 0) when missing; true only for the call that created it (once-per-period markers). */
  insertOnce(userId: string, missionId: string, periodKey: string): Promise<boolean>;
  /** Locks the row, creating it with progress 0 when missing. */
  lockOrCreate(userId: string, missionId: string, periodKey: string, session: DbSession): Promise<MissionProgressRow>;
  markClaimed(userId: string, missionId: string, periodKey: string, at: Date, session: DbSession): Promise<void>;
  /** Drops the daily rows of game days before `beforeDayKey` (achievement rows are kept). */
  deleteDailyBefore(userId: string, beforeDayKey: string): Promise<void>;
}
