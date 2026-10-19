import type { CharacterDTO } from "../../../config/DTO/characterCatalogDto";
import { CharacterSkillDTO, SkillEffectDTO, StatusId } from "../types/battle-data";

export function listEmbeddedSkills(character: CharacterDTO | null | undefined): CharacterSkillDTO[] {
  if (!character || !Array.isArray(character.skills)) return [];
  return character.skills.filter((skill) => !!skill && !!skill.id);
}

export function findCharacterSkill(
  character: CharacterDTO | null | undefined,
  skillId: string
): CharacterSkillDTO | undefined {
  if (!skillId) return undefined;
  return listEmbeddedSkills(character).find((skill) => skill.id === skillId);
}

export function listStatusEffects(skill: CharacterSkillDTO | null | undefined): SkillEffectDTO[] {
  if (!skill || !Array.isArray(skill.effects)) return [];
  return skill.effects.filter((effect) => {
    return effect.type === "ApplyStatus"
      || effect.type === "Strip"
      || effect.type === "StealBuffs"
      || effect.type === "TurnBar"
      || effect.type === "CooldownChange";
  });
}

export function findStatusEffectByStatus(
  skill: CharacterSkillDTO | null | undefined,
  statusId: StatusId
): SkillEffectDTO | undefined {
  return listStatusEffects(skill).find((effect) => effect.type === "ApplyStatus" && effect.status === statusId);
}
