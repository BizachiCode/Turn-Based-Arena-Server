import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { StageDifficulty } from "../../shared/kernel/types.js";
import type { MapCatalog, MapStage } from "../../config/MapCatalog.js";

export type StageProgressRecord = {
  regionId: string;
  stageId: string;
  difficulty: StageDifficulty;
  clears: number;
  bestClearMs: number | null;
};

export type StageClearOutcome = {
  firstClear: boolean;
  clears: number;
  bestClearMs: number | null;
};

/** Persistence port for stage progress and map preferences. */
export interface MapProgressRepository {
  /** Every stage/difficulty cleared at least once. */
  listProgress(userId: string, session?: DbSession): Promise<StageProgressRecord[]>;
  touchPrefs(userId: string, regionId: string, stageId: string, difficulty: StageDifficulty, session?: DbSession): Promise<void>;
  /** Increments the clear counter (locking the row) and reports whether it was the first clear. */
  recordClear(userId: string, regionId: string, stageId: string, difficulty: StageDifficulty, clearMs: number | null, session: DbSession): Promise<StageClearOutcome>;
}

/**
 * Extra entry condition checked before the unlock rules (dungeon schedule / level gate).
 * Returns the `{ code, message }` failure or null when the stage may be entered.
 */
export interface StageEntryGate {
  check(userId: string, regionId: string, stageId?: string): Promise<{ code: string; message: string } | null>;
}

/** Runs several gates in order; the first refusal wins. */
export function composeGates(...gates: StageEntryGate[]): StageEntryGate {
  return {
    async check(userId, regionId, stageId) {
      for (const gate of gates) {
        const failure = await gate.check(userId, regionId, stageId);
        if (failure) return failure;
      }
      return null;
    },
  };
}

/** Map/stage definitions exported from Unity (`maps.json`). */
export interface MapRules {
  catalog(): MapCatalog;
  getStage(regionId: string, stageId: string): MapStage | undefined;
}
