// Pure ranking rules (mirrored by the Unity offline backend `OfflineRankingService`): which metric a category ranks,
// the level+exp score, tower seasons and competition ranks (ties share a rank).

import type { RankingCategoryConfig, RankingKind } from "../../config/RankingCatalog.js";
import type { TowerCatalog } from "../../config/TowerCatalog.js";
import { seasonKey } from "../tower/tower.domain.js";
import { weekKey } from "../guild/guild-quest.domain.js";

/** `level` ranks level first, then experience: score = level * scale + exp (exp is clamped below the scale). */
export const LEVEL_SCORE_SCALE = 1_000_000_000_000;

export function levelScore(level: number, exp: number): number {
  return Math.max(0, level) * LEVEL_SCORE_SCALE + Math.min(Math.max(0, exp), LEVEL_SCORE_SCALE - 1);
}

/** Whether a category ranks players or guilds. */
export type RankingSubject = "player" | "guild";

export function subjectOf(kind: RankingKind): RankingSubject {
  return kind === "guild" ? "guild" : "player";
}

/** What the repository computes for a player category. */
export type PlayerMetric =
  | { kind: "level" }
  | { kind: "arena" }
  | { kind: "collection" }
  | { kind: "tower"; seasons: Array<{ regionId: string; seasonKey: string }> }
  | { kind: "story"; regionIds: string[]; weights: number[] };

/** Metric of a player category at `now` (null when the category ranks guilds). */
export function playerMetricOf(
  category: Pick<RankingCategoryConfig, "kind" | "regionId" | "difficultyWeights">,
  context: { now: Date; towers: TowerCatalog; storyRegionIds: string[] },
): PlayerMetric | null {
  switch (category.kind) {
    case "level": return { kind: "level" };
    case "arena": return { kind: "arena" };
    case "collection": return { kind: "collection" };
    case "tower":
      return {
        kind: "tower",
        seasons: context.towers.towers
          .filter((tower) => !category.regionId || tower.regionId === category.regionId)
          .map((tower) => ({ regionId: tower.regionId, seasonKey: seasonKey(tower, context.now) })),
      };
    case "story": return { kind: "story", regionIds: [...context.storyRegionIds], weights: [...category.difficultyWeights] };
    default: return null;
  }
}

/** Key of the guild activity week of `now` (same week as the guild quests). */
export function guildWeekOf(now: Date, quests: { resetHourUtc: number; weekStartsOn: number }): string {
  return weekKey(now, quests.resetHourUtc, quests.weekStartsOn);
}

/** Competition ranking over rows already sorted by descending score: equal scores share a rank (1, 1, 3). */
export function assignRanks<T extends { score: number }>(rows: T[]): Array<T & { rank: number }> {
  let rank = 0;
  return rows.map((row, index) => {
    if (index === 0 || row.score !== rows[index - 1].score) rank = index + 1;
    return { ...row, rank };
  });
}

/** Number of entries a request gets: the asked limit (or the default), at most the category's cached size. */
export function effectiveLimit(requested: number | undefined, defaultSize: number, categorySize: number): number {
  return Math.max(1, Math.min(requested ?? defaultSize, categorySize));
}
