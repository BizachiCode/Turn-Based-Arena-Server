import type { CharacterDTO, StatsDTO } from "../../../config/DTO/characterCatalogDto";
import type { BattleContentMode, LeaderSkillDTO } from "../../../config/DTO/leaderSkillCatalogDto";
import { applyAdditionalBattleStatBonuses } from "./player-battle-stats";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function createEmptyStats(): StatsDTO {
  return {
    hp: 0,
    atk: 0,
    def: 0,
    spd: 0,
    sh: 0,
    cr: 0,
    cd: 0,
    res: 0,
    acc: 0,
    eva: 0,
  };
}

export type ApplyLeaderSkillInput = {
  baseStats: StatsDTO;
  currentStats: StatsDTO;
  character: CharacterDTO;
  leaderSkill: LeaderSkillDTO;
  mode: BattleContentMode;
};

export type LeaderSkillTargetContext = {
  ownerSideId: string;
  targetSideId: string;
  ownerUnitId: string;
  targetUnitId: string;
};

/** True when the leader skill has no content filter or `mode` is one of its contents. */
export function leaderSkillAppliesToMode(leaderSkill: LeaderSkillDTO, mode: BattleContentMode): boolean {
  return !leaderSkill.modeFilter || leaderSkill.modeFilter.length === 0 || (leaderSkill.modeFilter as string[]).includes(mode);
}

export function leaderSkillAppliesToCharacter(leaderSkill: LeaderSkillDTO, character: CharacterDTO): boolean {
  if (!leaderSkill.elementFilter || leaderSkill.elementFilter.length === 0) return true;
  const elementId = typeof character.element === "string" ? character.element : null;
  return !!elementId && leaderSkill.elementFilter.includes(elementId);
}

export function leaderSkillAppliesToTarget(
  leaderSkill: LeaderSkillDTO,
  context: LeaderSkillTargetContext
): boolean {
  switch (leaderSkill.scope) {
    case "Self":
      return context.ownerUnitId === context.targetUnitId;

    case "AllEnemies":
      return context.ownerSideId !== context.targetSideId;

    case "AllUnits":
      return true;

    case "AllAllies":
    default:
      return context.ownerSideId === context.targetSideId;
  }
}

export function applyLeaderSkillBonuses(input: ApplyLeaderSkillInput): StatsDTO {
  if (!leaderSkillAppliesToMode(input.leaderSkill, input.mode)) return input.currentStats;
  if (!leaderSkillAppliesToCharacter(input.leaderSkill, input.character)) return input.currentStats;

  const percentBonuses = {
    ...createEmptyStats(),
    ...(input.leaderSkill.percentBonuses ?? {}),
  };
  const flatBonuses = {
    ...createEmptyStats(),
    ...(input.leaderSkill.flatBonuses ?? {}),
  };

  const withPercent = applyAdditionalBattleStatBonuses(input.baseStats, input.currentStats, percentBonuses);
  return {
    hp: Math.max(0, withPercent.hp + Math.round(flatBonuses.hp)),
    atk: Math.max(0, withPercent.atk + Math.round(flatBonuses.atk)),
    def: Math.max(0, withPercent.def + Math.round(flatBonuses.def)),
    spd: Math.max(0, withPercent.spd + Math.round(flatBonuses.spd)),
    sh: Math.max(0, withPercent.sh + Math.round(flatBonuses.sh)),
    cr: clamp01(withPercent.cr + flatBonuses.cr),
    cd: clamp(withPercent.cd + flatBonuses.cd, 1, 5),
    res: clamp01(withPercent.res + flatBonuses.res),
    acc: clamp01(withPercent.acc + flatBonuses.acc),
    eva: clamp01(withPercent.eva + flatBonuses.eva),
  };
}
