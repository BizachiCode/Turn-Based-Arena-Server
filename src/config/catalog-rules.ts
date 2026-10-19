// Adapters exposing the file-backed game catalogs (exported by Unity) through the small rule
// interfaces the application services depend on. Tests replace these with in-memory fakes.

import { getCurrencyById, getCurrencyCatalog } from "./CurrencyCatalog.js";
import { getIconCatalog } from "./IconCatalog.js";
import { getMapCatalog, getStageById } from "./MapCatalog.js";
import { getHomeBuildableById, getHomeCatalog, getHomeIslandById, getNearestFootprintRotation } from "./HomeCatalog.js";
import {
  getMainStatValue,
  getRuneCatalog,
  getSubstatRoll,
  getUpgradeCost,
  getUpgradeCurrencyId,
  getUpgradeSuccessChance,
  isMainStatAllowed,
} from "./RuneCatalog.js";
import { getSummonById } from "./SummonCatalog.js";
import { getCharacterById } from "./CharacterCatalog.js";
import { resolveEffectiveSkillIds } from "../modules/battle-core/application/battle-state-factory.js";
import { getChatRulesFromConfig, getGuaranteedSummonsFromConfig, getNicknameRulesFromConfig, getPlayerCapacityFromConfig } from "./LiveConfigCatalog.js";
import type { CurrencyRules } from "../modules/economy/economy.ports.js";
import type { IconRules, NicknameRules } from "../modules/profile/profile.ports.js";
import type { MapRules } from "../modules/map/map.ports.js";
import type { HomeRules } from "../modules/home/home.ports.js";
import type { RuneRules } from "../modules/rune/rune.ports.js";
import type { SummonRules } from "../modules/summon/summon.ports.js";
import type { CharacterRules } from "../modules/roster/character-grant.service.js";
import type { Capacity, SkillUpRules } from "../modules/roster/roster.ports.js";
import type { ChatRulesDto } from "../modules/chat/chat.dto.js";

export const currencyRules: CurrencyRules = {
  get: (currencyId) => getCurrencyById(currencyId),
  list: () => getCurrencyCatalog().currencies ?? [],
};

export const iconRules: IconRules = {
  exists: (iconId) => {
    const lower = iconId.toLowerCase();
    return getIconCatalog().icons.some((icon) => (icon.id ?? "").toLowerCase() === lower);
  },
  defaultIconId: () => {
    const icons = getIconCatalog().icons ?? [];
    if (icons.length === 0) return "default-icon";
    return (icons.find((icon) => !!icon.unlocked) ?? icons[0]).id;
  },
};

export const nicknameRules = (): NicknameRules => getNicknameRulesFromConfig();

export const mapRules: MapRules = {
  catalog: () => getMapCatalog(),
  getStage: (regionId, stageId) => getStageById(regionId, stageId),
};

export const homeRules: HomeRules = {
  catalog: () => getHomeCatalog(),
  getBuildable: (id) => getHomeBuildableById(id),
  getIsland: (id) => getHomeIslandById(id),
  footprintFor: (buildable, yawDegrees) => getNearestFootprintRotation(buildable, yawDegrees),
};

export const runeRules: RuneRules = {
  catalog: () => getRuneCatalog(),
  isMainStatAllowed,
  mainStatValue: getMainStatValue,
  substatRoll: getSubstatRoll,
  upgradeSuccessChance: getUpgradeSuccessChance,
  upgradeCost: getUpgradeCost,
  upgradeCurrencyId: getUpgradeCurrencyId,
};

export const summonRules: SummonRules = {
  get: (scrollId) => getSummonById(scrollId),
  guaranteed: (scrollId) => getGuaranteedSummonsFromConfig().get(scrollId) ?? [],
};

export const characterRules: CharacterRules = {
  get: (characterId) => getCharacterById(characterId),
};

export const skillUpRules: SkillUpRules = {
  skills: (characterId, awakeningIndex) => {
    const character = getCharacterById(characterId);
    if (!character) return [];
    const skills = Array.isArray(character.skills) ? character.skills : [];
    const baseCount = Array.isArray(character.skillIds) && character.skillIds.length > 0 ? character.skillIds.length : skills.length;
    // Leveled slots = the base skill slots; an awakening replacement keeps its slot (and its level).
    const ids = Array.isArray(character.skillIds) && character.skillIds.length > 0
      ? resolveEffectiveSkillIds(character, awakeningIndex).slice(0, baseCount)
      : skills.map((skill) => skill.id);
    return ids.map((id) => ({ id, maxLevel: Math.max(1, skills.find((skill) => skill.id === id)?.maxSkillLevel ?? 1) }));
  },
  isSkillUpMaterial: (characterId) => getCharacterById(characterId)?.skillUpMaterial === true,
};

export const capacityDefaults = (): Capacity => {
  const capacity = getPlayerCapacityFromConfig();
  return { bagCapacity: capacity.bagInit, storageCapacity: capacity.storageInit };
};

export const chatRules = (): ChatRulesDto => getChatRulesFromConfig();
