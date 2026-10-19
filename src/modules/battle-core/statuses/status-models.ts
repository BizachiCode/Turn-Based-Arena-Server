import { StatusId } from "../types/battle-data";

export type BattleUnitStats = {
  atk: number;
  def: number;
  spd: number;
  cr: number;
  cd: number;
  res: number;
  acc: number;
  eva: number;
};

export type BattleActiveStatus = {
  status: StatusId;
  remainingTurns: number;
  magnitude: number;
  percentPerTurn: number;
  isBuff: boolean;
  isDispellable: boolean;
  stacks: number;
  maxStacks: number;
  uniqueTag?: string | null;
  sourceId?: string | null;
  /**
   * Value-based payload: Shield = remaining absorb amount, Bomb = detonation damage (snapshot at application),
   * Endure = remaining charges when authored with a magnitude > 0, Berserk = SPD bonus. Null/undefined for other
   * statuses.
   */
  value?: number | null;
  /** True when the status was applied by the bearer to itself during its own turn: the next end-of-turn tick is skipped. */
  skipNextTick?: boolean;
  /** Passive that granted this status to its owner (suppressed while the owner has Oblivion). */
  passiveId?: string | null;
};

export type BattleStatusState = {
  unitId: string;
  stats: BattleUnitStats;
  currentHp: number;
  maxHp: number;
  /** Total absorb: innate shield (stats / revive) + remaining value of every active Shield status. */
  shield: number;
  turnBar: number;
  turnThreshold: number;
  cooldowns: Record<string, number>;
  statuses: BattleActiveStatus[];
};

export type BattleStatusSummary = {
  /** Hard crowd control (Stun / Freeze / Sleep): the turn is skipped. */
  cannotAct: boolean;
  /** Silence: only skills without cooldown can be used. */
  cannotUseSkills: boolean;
  invulnerable: boolean;
  debuffImmune: boolean;
  buffBlocked: boolean;
  healBlocked: boolean;
  hasEndure: boolean;
  /** Provoke: the unit must use its first skill on this unit (null = not provoked). */
  forcedTargetId: string | null;
  /** Oblivion: passive triggers and passive-granted self statuses are disabled. */
  passivesSealed: boolean;
  /** Additive modifiers applied to the base stat (+50% ATK = base ATK * 0.5). */
  attackModifier: number;
  defenseModifier: number;
  speedModifier: number;
  critRateBonus: number;
  critDamageBonus: number;
  incomingDamageMultiplier: number;
  glancingChanceBonus: number;
  counterattackChance: number;
  reflectDamagePercent: number;
  /** CritResistUp: subtracted from the crit rate of attackers hitting the bearer. */
  critResistBonus: number;
  /** Threat: enemy single-target skills must target a Threat bearer. */
  hasThreat: boolean;
  /** Unrevivable: revives are blocked. */
  unrevivable: boolean;
  /** Freeze: attack bar increases from effects are blocked. */
  turnBarIncreaseBlocked: boolean;
  /** InabilityImmunity: Stun, Freeze and Sleep are blocked. */
  hardControlImmune: boolean;
};

export type StatusApplyBlockReason =
  | "IMMUNITY"
  | "BENEFICIAL_BLOCK"
  | "RESISTED"
  | "MAX_STACKS"
  | "INVALID";

export type StatusRemoveReason =
  | "expired"
  | "strip"
  | "steal"
  | "cleanse"
  | "damage_break"
  | "consumed"
  | "detonated"
  | "replaced"
  | "transfer"
  | "duration";

export type DamageKind = "attack" | "reflect" | "bomb";

export type UnitDeathCause = "attack" | "reflect" | "bomb" | "continuous_damage";

export type BattleStatusEvent =
  | {
      type: "status_applied";
      targetId: string;
      sourceId?: string | null;
      status: StatusId;
      isBuff: boolean;
      duration: number;
      stacks: number;
      magnitude?: number;
      value?: number | null;
    }
  | {
      type: "status_blocked";
      targetId: string;
      sourceId?: string | null;
      status: StatusId;
      reason: StatusApplyBlockReason;
    }
  | {
      type: "status_removed";
      targetId: string;
      sourceId?: string | null;
      status: StatusId;
      reason: StatusRemoveReason;
    }
  | {
      type: "status_tick";
      targetId: string;
      status: StatusId;
      remainingTurns: number;
      isBuff: boolean;
    }
  | {
      type: "shield_changed";
      targetId: string;
      amount: number;
      currentShield: number;
    }
  | {
      type: "attack_missed";
      targetId: string;
      sourceId?: string | null;
      reason: "evasion" | "invulnerable";
      skillId?: string | null;
      hitIndex?: number;
      hitCount?: number;
    }
  | {
      type: "damage_applied";
      targetId: string;
      sourceId?: string | null;
      skillId?: string | null;
      amount: number;
      currentHp: number;
      currentShield: number;
      isCritical?: boolean;
      isGlancing?: boolean;
      isCrushing?: boolean;
      elementRelation?: number;
      hitIndex?: number;
      hitCount?: number;
      absorbed?: number;
      kind?: DamageKind;
      endured?: boolean;
    }
  | {
      type: "periodic_damage";
      targetId: string;
      sourceId?: string | null;
      status: StatusId;
      amount: number;
      currentHp: number;
      absorbed?: number;
      endured?: boolean;
    }
  | {
      type: "heal_applied";
      targetId: string;
      sourceId?: string | null;
      skillId?: string | null;
      amount: number;
      currentHp: number;
      overheal?: number;
      /** `lifesteal` for life steal (effect `lifeSteal`, Vampire runes); missing for other heals. */
      kind?: "lifesteal";
    }
  | {
      type: "heal_blocked";
      targetId: string;
      sourceId?: string | null;
      skillId?: string | null;
    }
  | {
      type: "max_hp_changed";
      targetId: string;
      sourceId?: string | null;
      amount: number;
      currentMaxHp: number;
      currentHp: number;
      /** `destroy` (effect `destroyMaxHp`, Destroy runes) or `aura` (passive auras). */
      kind: "destroy" | "aura";
    }
  | {
      type: "turn_bar_absorbed";
      targetId: string;
      sourceId: string;
      skillId?: string | null;
      amount: number;
    }
  | {
      type: "status_duration_changed";
      targetId: string;
      sourceId?: string | null;
      status: StatusId;
      isBuff: boolean;
      amount: number;
      remainingTurns: number;
    }
  | {
      type: "revive_blocked";
      targetId: string;
      sourceId?: string | null;
      skillId?: string | null;
      reason: "UNREVIVABLE";
    }
  | {
      type: "periodic_heal";
      targetId: string;
      sourceId?: string | null;
      status: StatusId;
      amount: number;
      currentHp: number;
    }
  | {
      type: "unit_revived";
      targetId: string;
      sourceId?: string | null;
      revivedHp: number;
      currentHp: number;
      grantedShield: number;
      currentTurnBar: number;
      cleansedDebuffs: number;
    }
  | {
      type: "unit_died";
      targetId: string;
      sourceId?: string | null;
      cause: UnitDeathCause;
    }
  | {
      type: "turn_bar_changed";
      targetId: string;
      amount: number;
      currentTurnBar: number;
    }
  | {
      type: "cooldown_changed";
      targetId: string;
      skillId: string;
      amount: number;
      currentCooldown: number;
    }
  | {
      type: "effect_resisted";
      targetId: string;
      sourceId?: string | null;
      skillId?: string | null;
      effectType: string;
      reason: "RESISTED" | "IMMUNITY";
    };

export type BattleStatusOperationResult = {
  ok: boolean;
  state: BattleStatusState;
  events: BattleStatusEvent[];
  reason?: StatusApplyBlockReason;
};
