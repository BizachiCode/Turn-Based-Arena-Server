import type { StatsDTO } from "./characterCatalogDto";

/** Game content a battle belongs to: the stage's region kind, or `arena`. */
export type BattleContentMode = "story" | "dungeon" | "tower" | "arena";

/**
 * Content a leader skill can be limited to (`modeFilter`; empty = every content). Matches Unity `LeaderScope`
 * (General = no filter, Arena, Dungeon, Tower).
 */
export const LEADER_CONTENT_MODES = ["arena", "dungeon", "tower"] as const;

export type LeaderContentMode = typeof LEADER_CONTENT_MODES[number];

export const LEADER_SKILL_SCOPES = [
  "Self",
  "AllAllies",
  "AllEnemies",
  "AllUnits",
] as const;

export type LeaderSkillScope = typeof LEADER_SKILL_SCOPES[number];

export type LeaderSkillDTO = {
  id: string;
  displayName?: string | null;
  scope: LeaderSkillScope;
  percentBonuses?: Partial<StatsDTO>;
  flatBonuses?: Partial<StatsDTO>;
  /** Content the bonus is limited to (empty = all content). */
  modeFilter?: LeaderContentMode[];
  elementFilter?: string[];
};

export type LeaderSkillCatalog = {
  leaderSkills: LeaderSkillDTO[];
};
