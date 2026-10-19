// Stage unlock rules (pure).
// Story regions: stages unlock in order, a region unlocks when the previous story region is fully cleared on the same
// difficulty, and a difficulty unlocks when every story stage is cleared on the previous one.
// Dungeon halls: only the first difficulty exists and each floor unlocks when the previous floor was cleared
// (their weekday schedule and level gate are checked by DungeonService).
// Towers: only the first difficulty exists; floors are climbed in order once per season (checked by TowerService).

import { STAGE_DIFFICULTIES, type StageDifficulty } from "../../shared/kernel/types.js";
import { storyRegions, type MapCatalog } from "../../config/MapCatalog.js";
import type { StageProgressRecord } from "./map.ports.js";

export type UnlockFailure = { code: string; message: string };

const key = (regionId: string, stageId: string) => `${regionId}::${stageId}`;

export function evaluateStageUnlock(
  catalog: MapCatalog,
  progress: StageProgressRecord[],
  regionId: string,
  stageId: string,
  difficulty: StageDifficulty,
): UnlockFailure | null {
  const clearedOn = (diff: StageDifficulty) => new Set(
    progress.filter((row) => row.difficulty === diff && row.clears > 0).map((row) => key(row.regionId, row.stageId)),
  );

  const region = catalog.regions.find((entry) => entry.id === regionId);
  if (!region) return { code: "REGION_NOT_FOUND", message: "Region not found." };

  const stageIndex = region.stages.findIndex((stage) => stage.id === stageId);
  if (stageIndex < 0) return { code: "STAGE_NOT_FOUND", message: "Stage not found." };

  const difficultyIndex = STAGE_DIFFICULTIES.indexOf(difficulty);

  if (region.kind === "tower") {
    return difficultyIndex === 0 ? null : { code: "DIFFICULTY_LOCKED", message: "Difficulty is locked." };
  }

  if (region.kind === "dungeon") {
    if (difficultyIndex !== 0) return { code: "DIFFICULTY_LOCKED", message: "Difficulty is locked." };
    if (stageIndex > 0 && !clearedOn(difficulty).has(key(region.id, region.stages[stageIndex - 1].id))) {
      return { code: "STAGE_LOCKED", message: "Stage is locked." };
    }
    return null;
  }

  const story = storyRegions(catalog);
  const regionIndex = story.findIndex((entry) => entry.id === regionId);

  if (difficultyIndex > 0) {
    const previous = clearedOn(STAGE_DIFFICULTIES[difficultyIndex - 1]);
    const allCleared = story.every((entry) => entry.stages.every((stage) => previous.has(key(entry.id, stage.id))));
    if (!allCleared) return { code: "DIFFICULTY_LOCKED", message: "Difficulty is locked." };
  }

  const current = clearedOn(difficulty);
  if (regionIndex > 0) {
    const previousRegion = story[regionIndex - 1];
    if (!previousRegion.stages.every((stage) => current.has(key(previousRegion.id, stage.id)))) {
      return { code: "REGION_LOCKED", message: "Region is locked." };
    }
  }

  if (stageIndex > 0 && !current.has(key(region.id, region.stages[stageIndex - 1].id))) {
    return { code: "STAGE_LOCKED", message: "Stage is locked." };
  }

  return null;
}
