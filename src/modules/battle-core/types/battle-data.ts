export const STATUS_IDS = [
  "DefenseBreak",
  "AttackBreak",
  "Glancing",
  "HealBlock",
  "Unrecoverable",
  "ContinuousDamage",
  "Brand",
  "Slow",
  "Stun",
  "Freeze",
  "Sleep",
  "Silence",
  "Oblivion",
  "Provoke",
  "Bomb",
  "AttackUp",
  "DefenseUp",
  "Shield",
  "Immunity",
  "Invincibility",
  "Endure",
  "SpeedUp",
  "CritRateUp",
  "CritDamageUp",
  "Counterattack",
  "ReflectDamage",
  "HpRegen",
  "BeneficialBlock",
  "DamageReduction",
  "CritResistUp",
  "Threat",
  "Unrevivable",
  "Berserk",
  "InabilityImmunity",
] as const;

/**
 * Status aliases: the alias is stored and reported as its canonical status (same rules, one code path).
 * `Unrecoverable` is another name for `HealBlock`.
 */
export const STATUS_ALIASES: Readonly<Partial<Record<string, string>>> = Object.freeze({
  Unrecoverable: "HealBlock",
});

export type StatusId = typeof STATUS_IDS[number];

/**
 * Skill effect types. The numeric index of each entry matches the Unity `SkillEffectType` enum,
 * so new values are only ever appended.
 */
export const SKILL_EFFECT_TYPES = [
  "Damage",
  "Heal",
  "ApplyStatus",
  "Revive",
  "Strip",
  "StealBuffs",
  "TurnBar",
  "CooldownChange",
  "Cleanse",
  "AbsorbTurnBar",
  "ExtraTurn",
  "AdditionalAttack",
  "AllyAttack",
  "TransferDebuffs",
  "ChangeStatusDuration",
] as const;

export type SkillEffectType = typeof SKILL_EFFECT_TYPES[number];

/** Stat of a damage / heal term. `TargetMaxHP` / `TargetSpeed` read the unit hit (damage terms only). */
export const STAT_TERM_SOURCES = [
  "Attack",
  "MaxHP",
  "Defense",
  "Speed",
  "TargetMaxHP",
  "TargetSpeed",
] as const;

export type StatTermSource = typeof STAT_TERM_SOURCES[number];

/**
 * Extra multiplier of a Damage effect, evaluated per hit before defense with `scalingAmount`
 * (see docs/BATTLE_RULES.md). Index = Unity `DamageScaling`.
 */
export const DAMAGE_SCALINGS = [
  "None",
  "TargetHpLow",
  "TargetHpHigh",
  "CasterHpLow",
  "CasterHpHigh",
  "TargetDebuffCount",
  "CasterBuffCount",
  "CasterSpeed",
] as const;

export type DamageScaling = typeof DAMAGE_SCALINGS[number];

/**
 * Skill targeting (area) modes (index = Unity `TargetingMode`). `CircleAroundTarget` / `LineFromTarget` resolve to
 * "every unit on the primary target's side" (the battle has no geometry).
 */
export const TARGETING_MODES = [
  "SingleTarget",
  "CircleAroundTarget",
  "LineFromTarget",
  "AllEnemies",
  "AllAllies",
  "RandomEnemies",
] as const;

export type TargetingMode = typeof TARGETING_MODES[number];

export const ALLOWED_TARGET_LINES = [
  "Any",
  "FrontlineOnly",
  "BacklineOnly",
] as const;

export type AllowedTargetLine = typeof ALLOWED_TARGET_LINES[number];

/** Which side a skill's primary target must belong to. `Auto` derives the side from the skill effects. */
export const SKILL_TARGET_SIDES = [
  "Auto",
  "Enemy",
  "Ally",
  "Self",
] as const;

export type SkillTargetSide = typeof SKILL_TARGET_SIDES[number];

/** Per-effect target scope. `SkillTargets` (default) uses the targets resolved by the skill targeting mode. */
export const EFFECT_TARGET_SCOPES = [
  "SkillTargets",
  "Self",
  "PrimaryTarget",
  "AllAllies",
  "AllEnemies",
  "LowestHpAlly",
  "RandomEnemy",
] as const;

export type EffectTargetScope = typeof EFFECT_TARGET_SCOPES[number];

/** Per-effect condition evaluated for every resolved target. */
export const EFFECT_CONDITIONS = [
  "Always",
  "OnHit",
  "OnCrit",
  "TargetHpBelow",
  "OnKill",
  "TargetHasDebuff",
  "TargetHasNoBuff",
  "TargetHasNoDebuff",
  "CasterHpBelow",
  "CasterHasStatus",
  "TargetHasStatus",
  "TargetIsNotBoss",
  "CasterStatHigher",
] as const;

export type EffectCondition = typeof EFFECT_CONDITIONS[number];

/** Stat compared by `CasterStatHigher` (index = Unity `ConditionStat`). */
export const CONDITION_STATS = [
  "Attack",
  "Defense",
  "Speed",
  "MaxHP",
  "HpRatio",
] as const;

export type ConditionStat = typeof CONDITION_STATS[number];

/** Formation line of a unit (used by `allowedLine`). */
export const BATTLE_LINES = [
  "Frontline",
  "Backline",
] as const;

export type BattleLine = typeof BATTLE_LINES[number];

export const SKILL_COMBAT_ROLES = [
  "Attack",
  "Control",
  "Support",
  "Recovery",
  "Utility",
] as const;

export type SkillCombatRole = typeof SKILL_COMBAT_ROLES[number];

export const PASSIVE_TRIGGER_IDS = [
  "OnBattleStart",
  "OnTurnStart",
  "OnAttack",
  "OnDamaged",
  "OnDeath",
  "OnTurnEnd",
  "OnCrit",
  "OnKill",
  "OnAllyDeath",
  "OnDebuffed",
  "BeforeAttack",
  "OnCritReceived",
  "OnHealed",
] as const;

export type PassiveTriggerId = typeof PASSIVE_TRIGGER_IDS[number];

export const PASSIVE_TARGET_MODES = [
  "Self",
  "AllAllies",
  "AllEnemies",
  "PrimaryTarget",
  "Attacker",
  "LowestHpAlly",
  "RandomEnemy",
] as const;

export type PassiveTargetMode = typeof PASSIVE_TARGET_MODES[number];

export const PASSIVE_AURA_SCOPES = [
  "Self",
  "AllAllies",
  "AllEnemies",
] as const;

export type PassiveAuraScope = typeof PASSIVE_AURA_SCOPES[number];

/** Stat changed by a passive aura. Index = Unity `AuraStat`. */
export const AURA_STATS = [
  "MaxHP",
  "Attack",
  "Defense",
  "Speed",
  "CritRate",
  "CritDamage",
  "Resistance",
  "Accuracy",
  "Evasion",
] as const;

export type AuraStat = typeof AURA_STATS[number];

export type StatTermDTO = {
  source: StatTermSource;
  multiplier: number;
};

export type SkillEffectDTO = {
  type: SkillEffectType;
  applyEverySplit: boolean;
  damageTerms: StatTermDTO[];
  defenseConstant: number;
  critMultiplier: number;
  flatDamageBonus: number;
  healFromSource: boolean;
  healStat: StatTermSource;
  healScale: number;
  flatHealBonus: number;
  status: StatusId;
  statusDuration: number;
  statusMagnitude: number;
  statusPercentPerTurn: number;
  applyChance: number;
  isBuff: boolean;
  reviveHpPercent: number;
  buffCount: number;
  baseChance: number;
  turnBarIncrease: boolean;
  turnBarAmount: number;
  cooldownIncrease: boolean;
  cooldownTurns: number;
  /** Target scope of this effect (default `SkillTargets`). */
  target?: EffectTargetScope | null;
  /** Condition evaluated per target (default `Always`). */
  condition?: EffectCondition | null;
  /** Threshold of `TargetHpBelow` / `CasterHpBelow` (HP ratio 0..1), factor of `CasterStatHigher`. */
  conditionValue?: number;
  /** Status checked by `CasterHasStatus` / `TargetHasStatus`. */
  conditionStatus?: StatusId | null;
  /** Stat compared by `CasterStatHigher` (default `Attack`). */
  conditionStat?: ConditionStat | null;
  /** Number of hits of a `Damage` effect (default 1). Every hit rolls hit/crit/glancing separately. */
  hits?: number;
  /** Damage: extra multiplier from HP ratios, status counts or speed (default `None`). */
  scaling?: DamageScaling | null;
  /** Damage: strength of `scaling`. */
  scalingAmount?: number;
  /** Damage: fraction (0..1) of the target's DEF ignored. */
  ignoreDefense?: number;
  /** Damage: every non-glancing hit is critical. */
  guaranteedCrit?: boolean;
  /** Damage: added to the critical multiplier of this effect. */
  critDamageBonus?: number;
  /** Damage: the caster heals this fraction (0..1) of the HP damage dealt by the effect. */
  lifeSteal?: number;
  /** Damage: the target's max HP drops by this fraction (0..1) of the HP damage of each hit (battle cap 60%). */
  destroyMaxHp?: number;
  /** Harmful effects of this entry skip the resistance roll (base chance and Immunity still apply). */
  irresistible?: boolean;
  /** Damage: hits cannot be glancing. */
  noGlancing?: boolean;
};

/**
 * Cumulative bonus of a skill level (skill-ups): damage and recovery scale by `1 + pct / 100`,
 * `effectChancePct` adds to the harmful-effect / apply chances. `levelBonuses[0]` is level 1 (usually all 0).
 */
export type SkillLevelBonusDTO = {
  damagePct: number;
  healPct: number;
  effectChancePct: number;
};

export type CharacterSkillDTO = {
  id: string;
  name?: string | null;
  combatRole?: SkillCombatRole | null;
  targeting?: TargetingMode | null;
  allowedLine?: AllowedTargetLine | null;
  areaRadius?: number;
  lineLength?: number;
  maxSkillLevel: number;
  cooldownByLevel: number[];
  /** Cumulative bonuses per skill level (index = level - 1); missing = no bonus. */
  levelBonuses?: SkillLevelBonusDTO[];
  effects: SkillEffectDTO[];
  /** Side the primary target must belong to (default `Auto`, derived from the effects). */
  targetSide?: SkillTargetSide | null;
  /** Number of distinct random enemies hit by `RandomEnemies` (default 1). */
  randomTargetCount?: number;
};

export type CharacterPassiveTriggerDTO = {
  trigger: PassiveTriggerId;
  chance: number;
  target: PassiveTargetMode;
  effects: SkillEffectDTO[];
  /** Bearer turns before the trigger can fire again (0 = none). */
  cooldown?: number;
  /** Fires allowed per battle (0 = unlimited). */
  maxPerBattle?: number;
};

/**
 * Passive aura: `stat` + `percent` (of the receiver's base stat; MaxHP: of its max HP without auras; rates: added as
 * a fraction) + `flat` on the units of `scope` whose element is in `elementFilter` (empty = all). Evaluated during the
 * battle: it counts while the bearer is alive (`activeWhileAlive`) and not under Oblivion.
 */
export type CharacterPassiveAuraDTO = {
  stat: AuraStat;
  percent: number;
  flat: number;
  scope: PassiveAuraScope;
  elementFilter?: string[];
  activeWhileAlive: boolean;
};

export type CharacterPassiveDTO = {
  id: string;
  name?: string | null;
  triggers: CharacterPassiveTriggerDTO[];
  auras?: CharacterPassiveAuraDTO[];
};

function isNamedEnumValue<T extends readonly string[]>(
  values: T,
  candidate: string
): candidate is T[number] {
  return (values as readonly string[]).includes(candidate);
}

export function normalizeNamedEnumValue<T extends readonly string[]>(
  values: T,
  raw: unknown,
): T[number] | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return isNamedEnumValue(values, trimmed) ? trimmed : null;
  }

  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < values.length) {
    return values[raw];
  }

  return null;
}

export function normalizeStatusId(raw: unknown): StatusId | null {
  return normalizeNamedEnumValue(STATUS_IDS, raw);
}

/** Canonical status of an id (`STATUS_ALIASES`): `Unrecoverable` -> `HealBlock`. */
export function canonicalStatusId(status: StatusId): StatusId {
  return (STATUS_ALIASES[status] as StatusId | undefined) ?? status;
}

export function normalizeSkillEffectType(raw: unknown): SkillEffectType | null {
  return normalizeNamedEnumValue(SKILL_EFFECT_TYPES, raw);
}

export function normalizeDamageScaling(raw: unknown): DamageScaling | null {
  return normalizeNamedEnumValue(DAMAGE_SCALINGS, raw);
}

export function normalizeConditionStat(raw: unknown): ConditionStat | null {
  return normalizeNamedEnumValue(CONDITION_STATS, raw);
}

export function normalizeAuraStat(raw: unknown): AuraStat | null {
  return normalizeNamedEnumValue(AURA_STATS, raw);
}

export function normalizeStatTermSource(raw: unknown): StatTermSource | null {
  return normalizeNamedEnumValue(STAT_TERM_SOURCES, raw);
}

export function normalizeTargetingMode(raw: unknown): TargetingMode | null {
  return normalizeNamedEnumValue(TARGETING_MODES, raw);
}

export function normalizeAllowedTargetLine(raw: unknown): AllowedTargetLine | null {
  return normalizeNamedEnumValue(ALLOWED_TARGET_LINES, raw);
}

export function normalizeSkillCombatRole(raw: unknown): SkillCombatRole | null {
  return normalizeNamedEnumValue(SKILL_COMBAT_ROLES, raw);
}

export function normalizePassiveTriggerId(raw: unknown): PassiveTriggerId | null {
  return normalizeNamedEnumValue(PASSIVE_TRIGGER_IDS, raw);
}

export function normalizePassiveTargetMode(raw: unknown): PassiveTargetMode | null {
  return normalizeNamedEnumValue(PASSIVE_TARGET_MODES, raw);
}

export function normalizePassiveAuraScope(raw: unknown): PassiveAuraScope | null {
  return normalizeNamedEnumValue(PASSIVE_AURA_SCOPES, raw);
}

export function normalizeSkillTargetSide(raw: unknown): SkillTargetSide | null {
  return normalizeNamedEnumValue(SKILL_TARGET_SIDES, raw);
}

export function normalizeEffectTargetScope(raw: unknown): EffectTargetScope | null {
  return normalizeNamedEnumValue(EFFECT_TARGET_SCOPES, raw);
}

export function normalizeEffectCondition(raw: unknown): EffectCondition | null {
  return normalizeNamedEnumValue(EFFECT_CONDITIONS, raw);
}

export function normalizeBattleLine(raw: unknown): BattleLine | null {
  if (typeof raw === "string") {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "frontline" || lowered === "front") return "Frontline";
    if (lowered === "backline" || lowered === "back") return "Backline";
    return null;
  }
  return normalizeNamedEnumValue(BATTLE_LINES, raw);
}

export function isStatusId(raw: unknown): raw is StatusId {
  return normalizeStatusId(raw) !== null;
}
