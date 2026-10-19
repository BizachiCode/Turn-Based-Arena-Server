import { CharacterPassiveDTO, CharacterSkillDTO } from "../../modules/battle-core/types/battle-data";

export type StatsDTO = {
  hp: number; atk: number; def: number; spd: number; sh: number;
  cr: number; cd: number; res: number; acc: number; eva: number;
};
export type StatMultDTO = {
  hp: number; atk: number; def: number; spd: number; sh: number;
  cr: number; cd: number; res: number; acc: number; eva: number;
};
export type GrowthDTO   = {
  hp: number; atk: number; def: number; spd: number;
  cr: number; cd: number; res: number; acc: number; eva: number;
};
export type StarOverrideDTO = { star: number; baseMul: StatMultDTO; perLevel: GrowthDTO };

/** Manual stat table of one star tier: `levels[0]` is level 1. */
export type StarLevelStatsDTO = { star: number; levels: StatsDTO[] };

export type AwakeningCostDTO = { currencyId: string; amount: number };

export type AwakeningTuningDTO = {
  starOverrides: StarOverrideDTO[];
  flatBonus: StatsDTO;
  perLevelBonus: GrowthDTO;
  /** When true the awakened form grows from `baseStats` instead of the character's base stats. */
  useCustomBaseStats?: boolean;
  baseStats?: StatsDTO;
  /** When true `manualStarLevelStats` replaces the formula for the levels it covers. */
  useManualStarLevelStats?: boolean;
  manualStarLevelStats?: StarLevelStatsDTO[];
};


/** Awakening upgrade of a skill / passive: `to` takes the slot of `from` (skill levels carry over). */
export type AwakeningReplacementDTO = { from: string; to: string };

export type AwakeningRewardsDTO = {
  leaderSkillId?: string | null;
  addSkillIds?: string[];
  addPassiveIds?: string[];
  replaceSkills?: AwakeningReplacementDTO[];
  replacePassives?: AwakeningReplacementDTO[];
  extraFlatBonus?: StatsDTO;
};

export type AwakeningStepDTO = {
  index: number;      // 1..N
  minLevel: number;
  minStars: number;   // 1..6
  costs: AwakeningCostDTO[];
  tuning: AwakeningTuningDTO;
  rewards: AwakeningRewardsDTO;
};

export type CharacterDTO = {
  id: string;
  element?: string | null;
  naturalStars: number;

  baseStats: StatsDTO;
  starOverrides: StarOverrideDTO[];
  /** When true `manualStarLevelStats` replaces the formula for the levels it covers. */
  useManualStarLevelStats?: boolean;
  manualStarLevelStats?: StarLevelStatsDTO[];

  leaderSkillId?: string | null;
  passiveIds?: string[];
  skillIds?: string[];
  passives?: CharacterPassiveDTO[];
  skills?: CharacterSkillDTO[];

  awakenings?: AwakeningStepDTO[];

  /** Skill-up material: as power-up fodder it always levels up one skill of the target. */
  skillUpMaterial?: boolean;
};

export type CharacterCatalog = { characters: CharacterDTO[] };
