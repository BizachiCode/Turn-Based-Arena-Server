import {
  ALLOWED_TARGET_LINES,
  AURA_STATS,
  PASSIVE_AURA_SCOPES,
  PASSIVE_TARGET_MODES,
  PASSIVE_TRIGGER_IDS,
  SKILL_EFFECT_TYPES,
  STATUS_IDS,
  STAT_TERM_SOURCES,
  normalizeAllowedTargetLine,
  normalizeAuraStat,
  normalizeConditionStat,
  normalizeDamageScaling,
  normalizeEffectCondition,
  normalizeEffectTargetScope,
  normalizePassiveAuraScope,
  normalizePassiveTargetMode,
  normalizePassiveTriggerId,
  normalizeSkillCombatRole,
  normalizeSkillEffectType,
  normalizeSkillTargetSide,
  normalizeStatTermSource,
  normalizeStatusId,
  normalizeTargetingMode,
  type CharacterPassiveAuraDTO,
  type CharacterPassiveDTO,
  type CharacterPassiveTriggerDTO,
  type CharacterSkillDTO,
  type SkillEffectDTO,
  type StatTermDTO,
} from "./battle-data";

/*
 * Normalizers for character skill / passive JSON (exported by Unity `CharacterJsonExporter`). They accept missing
 * fields and enum names or indices, and fill the same defaults as the Unity data model. The server character
 * catalog should delegate to these so that new battle fields are not dropped.
 */

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeStatTermDTO(raw: any): StatTermDTO | null {
  if (!raw) return null;
  return {
    source: normalizeStatTermSource(raw.source) ?? STAT_TERM_SOURCES[0],
    multiplier: isNum(raw.multiplier) ? raw.multiplier : 0,
  };
}

/**
 * Normalizes one skill effect, including `target`, `condition`, `conditionValue`, `hits` and the Damage modifiers
 * (`scaling`, `ignoreDefense`, `guaranteedCrit`, `critDamageBonus`, `lifeSteal`, `destroyMaxHp`, `noGlancing`) and
 * `irresistible`.
 */
export function normalizeSkillEffectDTO(raw: any): SkillEffectDTO | null {
  if (!raw || typeof raw !== "object") return null;

  const type = normalizeSkillEffectType(raw.type) ?? SKILL_EFFECT_TYPES[0];
  const damageTerms: StatTermDTO[] = Array.isArray(raw.damageTerms)
    ? raw.damageTerms.map(normalizeStatTermDTO).filter(Boolean) as StatTermDTO[]
    : [];

  return {
    type,
    applyEverySplit: !!raw.applyEverySplit,
    damageTerms: type === "Damage" && damageTerms.length === 0 ? [{ source: "Attack", multiplier: 1 }] : damageTerms,
    defenseConstant: isNum(raw.defenseConstant) ? raw.defenseConstant : 100,
    critMultiplier: isNum(raw.critMultiplier) ? raw.critMultiplier : 1.5,
    flatDamageBonus: isNum(raw.flatDamageBonus) ? Math.round(raw.flatDamageBonus) : 0,
    healFromSource: raw.healFromSource !== false,
    healStat: normalizeStatTermSource(raw.healStat) ?? STAT_TERM_SOURCES[0],
    healScale: isNum(raw.healScale) ? raw.healScale : 0.3,
    flatHealBonus: isNum(raw.flatHealBonus) ? Math.round(raw.flatHealBonus) : 0,
    status: normalizeStatusId(raw.status) ?? STATUS_IDS[0],
    statusDuration: isNum(raw.statusDuration) ? Math.max(0, Math.floor(raw.statusDuration)) : 0,
    statusMagnitude: isNum(raw.statusMagnitude) ? raw.statusMagnitude : 0,
    statusPercentPerTurn: isNum(raw.statusPercentPerTurn) ? raw.statusPercentPerTurn : 0,
    applyChance: isNum(raw.applyChance) ? clamp01(raw.applyChance) : 1,
    isBuff: !!raw.isBuff,
    reviveHpPercent: isNum(raw.reviveHpPercent) ? clamp01(raw.reviveHpPercent) : 0.3,
    buffCount: isNum(raw.buffCount) ? Math.max(0, Math.floor(raw.buffCount)) : 1,
    baseChance: isNum(raw.baseChance) ? clamp01(raw.baseChance) : 1,
    turnBarIncrease: raw.turnBarIncrease !== false,
    turnBarAmount: isNum(raw.turnBarAmount) ? clamp01(raw.turnBarAmount) : 0.3,
    cooldownIncrease: raw.cooldownIncrease !== false,
    cooldownTurns: isNum(raw.cooldownTurns) ? Math.max(0, Math.floor(raw.cooldownTurns)) : 1,
    target: normalizeEffectTargetScope(raw.target) ?? "SkillTargets",
    condition: normalizeEffectCondition(raw.condition) ?? "Always",
    conditionValue: isNum(raw.conditionValue) ? Math.max(0, raw.conditionValue) : 0,
    conditionStatus: normalizeStatusId(raw.conditionStatus),
    conditionStat: normalizeConditionStat(raw.conditionStat) ?? "Attack",
    hits: isNum(raw.hits) ? Math.max(1, Math.floor(raw.hits)) : 1,
    scaling: normalizeDamageScaling(raw.scaling) ?? "None",
    scalingAmount: isNum(raw.scalingAmount) ? raw.scalingAmount : 0,
    ignoreDefense: isNum(raw.ignoreDefense) ? clamp01(raw.ignoreDefense) : 0,
    guaranteedCrit: !!raw.guaranteedCrit,
    critDamageBonus: isNum(raw.critDamageBonus) ? raw.critDamageBonus : 0,
    lifeSteal: isNum(raw.lifeSteal) ? clamp01(raw.lifeSteal) : 0,
    destroyMaxHp: isNum(raw.destroyMaxHp) ? clamp01(raw.destroyMaxHp) : 0,
    irresistible: !!raw.irresistible,
    noGlancing: !!raw.noGlancing,
  };
}

/** Normalizes one skill, including `targetSide` and `randomTargetCount`. Returns null without an id. */
export function normalizeCharacterSkillDTO(raw: any): CharacterSkillDTO | null {
  const id = str(raw?.id ?? raw?.skillId ?? raw?.SkillId);
  if (!id) return null;

  return {
    id,
    name: str(raw?.name ?? raw?.skillName) || null,
    combatRole: normalizeSkillCombatRole(raw?.combatRole),
    targeting: normalizeTargetingMode(raw?.targeting),
    allowedLine: normalizeAllowedTargetLine(raw?.allowedLine) ?? ALLOWED_TARGET_LINES[0],
    areaRadius: isNum(raw?.areaRadius) ? raw.areaRadius : 0,
    lineLength: isNum(raw?.lineLength) ? raw.lineLength : 0,
    maxSkillLevel: isNum(raw?.maxSkillLevel) ? Math.max(1, Math.floor(raw.maxSkillLevel)) : 1,
    cooldownByLevel: Array.isArray(raw?.cooldownByLevel)
      ? raw.cooldownByLevel.filter(isNum).map((value: number) => Math.max(0, Math.floor(value)))
      : [],
    levelBonuses: Array.isArray(raw?.levelBonuses)
      ? raw.levelBonuses.map((bonus: any) => ({
          damagePct: isNum(bonus?.damagePct) ? Math.max(0, bonus.damagePct) : 0,
          healPct: isNum(bonus?.healPct) ? Math.max(0, bonus.healPct) : 0,
          effectChancePct: isNum(bonus?.effectChancePct) ? Math.max(0, bonus.effectChancePct) : 0,
        }))
      : [],
    effects: Array.isArray(raw?.effects)
      ? raw.effects.map(normalizeSkillEffectDTO).filter(Boolean) as SkillEffectDTO[]
      : [],
    targetSide: normalizeSkillTargetSide(raw?.targetSide) ?? "Auto",
    randomTargetCount: isNum(raw?.randomTargetCount) ? Math.max(1, Math.floor(raw.randomTargetCount)) : 1,
  };
}

export function normalizeCharacterSkills(raw: unknown): CharacterSkillDTO[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCharacterSkillDTO).filter(Boolean) as CharacterSkillDTO[];
}

export function normalizePassiveTriggerDTO(raw: any): CharacterPassiveTriggerDTO | null {
  if (!raw) return null;
  return {
    trigger: normalizePassiveTriggerId(raw.trigger) ?? PASSIVE_TRIGGER_IDS[0],
    chance: isNum(raw.chance) ? clamp01(raw.chance) : 1,
    target: normalizePassiveTargetMode(raw.target) ?? PASSIVE_TARGET_MODES[0],
    effects: Array.isArray(raw.effects) ? raw.effects.map(normalizeSkillEffectDTO).filter(Boolean) as SkillEffectDTO[] : [],
    cooldown: isNum(raw.cooldown) ? Math.max(0, Math.floor(raw.cooldown)) : 0,
    maxPerBattle: isNum(raw.maxPerBattle) ? Math.max(0, Math.floor(raw.maxPerBattle)) : 0,
  };
}

function normalizeStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(str).filter((value) => value.length > 0) : [];
}

/** Normalizes one passive aura (`stat`, `percent`, `flat`, `scope`, `elementFilter`, `activeWhileAlive`). */
export function normalizePassiveAuraDTO(raw: any): CharacterPassiveAuraDTO | null {
  if (!raw) return null;
  return {
    stat: normalizeAuraStat(raw.stat) ?? AURA_STATS[0],
    percent: isNum(raw.percent) ? raw.percent : 0,
    flat: isNum(raw.flat) ? raw.flat : 0,
    scope: normalizePassiveAuraScope(raw.scope) ?? PASSIVE_AURA_SCOPES[0],
    elementFilter: normalizeStringList(raw.elementFilter),
    activeWhileAlive: raw.activeWhileAlive !== false,
  };
}

export function normalizeCharacterPassiveDTO(raw: any): CharacterPassiveDTO | null {
  const id = str(raw?.id ?? raw?.passiveId ?? raw?.PassiveId);
  if (!id) return null;
  return {
    id,
    name: str(raw?.name ?? raw?.passiveName) || null,
    triggers: Array.isArray(raw?.triggers) ? raw.triggers.map(normalizePassiveTriggerDTO).filter(Boolean) as CharacterPassiveTriggerDTO[] : [],
    auras: Array.isArray(raw?.auras) ? raw.auras.map(normalizePassiveAuraDTO).filter(Boolean) as CharacterPassiveAuraDTO[] : [],
  };
}

export function normalizeCharacterPassives(raw: unknown): CharacterPassiveDTO[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCharacterPassiveDTO).filter(Boolean) as CharacterPassiveDTO[];
}
