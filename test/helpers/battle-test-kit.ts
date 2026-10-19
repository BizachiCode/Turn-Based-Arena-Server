import type { CharacterDTO, StatsDTO } from "../../src/config/DTO/characterCatalogDto";
import {
  BattleEngine,
  PassiveRuntimeSystem,
  PveBattleRuleset,
  RuneSetRuntimeSystem,
  SeededBattleRandom,
  StaticCombatFormulaProvider,
  createDefaultCombatFormulaSnapshot,
  normalizeCombatFormulaSnapshot,
  type BattleRandom,
  type BattleRuleset,
  type CharacterPassiveDTO,
  type CharacterSkillDTO,
  type ResolvedCombatFormula,
  type SkillEffectDTO,
} from "../../src/modules/battle-core";

/** A fully populated skill effect with neutral defaults; override what the test needs. */
export function makeEffect(overrides: Partial<SkillEffectDTO> = {}): SkillEffectDTO {
  return {
    type: "Damage",
    applyEverySplit: false,
    damageTerms: [{ source: "Attack", multiplier: 1 }],
    defenseConstant: 100,
    critMultiplier: 1.5,
    flatDamageBonus: 0,
    healFromSource: true,
    healStat: "MaxHP",
    healScale: 0.3,
    flatHealBonus: 0,
    status: "Stun",
    statusDuration: 0,
    statusMagnitude: 0,
    statusPercentPerTurn: 0,
    applyChance: 1,
    isBuff: false,
    reviveHpPercent: 0.3,
    buffCount: 1,
    baseChance: 1,
    turnBarIncrease: true,
    turnBarAmount: 0.3,
    cooldownIncrease: true,
    cooldownTurns: 1,
    ...overrides,
  };
}

export function statusEffect(status: SkillEffectDTO["status"], duration: number, overrides: Partial<SkillEffectDTO> = {}): SkillEffectDTO {
  return makeEffect({ type: "ApplyStatus", damageTerms: [], status, statusDuration: duration, ...overrides });
}

export function makeSkill(id: string, effects: SkillEffectDTO[], overrides: Partial<CharacterSkillDTO> = {}): CharacterSkillDTO {
  return {
    id,
    maxSkillLevel: 1,
    cooldownByLevel: [0],
    effects,
    ...overrides,
  };
}

export function makeStats(overrides: Partial<StatsDTO> = {}): StatsDTO {
  return {
    hp: 1000,
    atk: 100,
    def: 100,
    spd: 100,
    sh: 0,
    cr: 0,
    cd: 1.5,
    res: 0,
    acc: 0,
    eva: 0,
    ...overrides,
  };
}

export function makeCharacter(params: {
  id: string;
  skills: CharacterSkillDTO[];
  passives?: CharacterPassiveDTO[];
  element?: string;
  stats?: Partial<StatsDTO>;
}): CharacterDTO {
  return {
    id: params.id,
    element: params.element ?? "neutral_element",
    naturalStars: 3,
    baseStats: makeStats(params.stats),
    starOverrides: [],
    skillIds: params.skills.map((skill) => skill.id),
    passiveIds: (params.passives ?? []).map((passive) => passive.id),
    skills: params.skills,
    passives: params.passives ?? [],
    awakenings: [],
  };
}

/**
 * Deterministic test formulas: every hit lands, no minimum resist, neutral elements unless overridden.
 * Overrides are merged per section.
 */
export function makeFormulas(overrides: Record<string, any> = {}): ResolvedCombatFormula {
  const base = createDefaultCombatFormulaSnapshot() as any;
  const merged: Record<string, any> = { ...base };
  const defaults: Record<string, any> = {
    accuracy: { baseHitChance: 1, minimumHitChance: 0, maximumHitChance: 1, minimumResistChance: 0 },
  };
  for (const section of ["timing", "accuracy", "damage", "healing", "revive", "elements", "statusDefaults", "turnOrder"]) {
    merged[section] = { ...(base[section] ?? {}), ...(defaults[section] ?? {}), ...(overrides[section] ?? {}) };
  }
  if (overrides.version) merged.version = overrides.version;
  return normalizeCombatFormulaSnapshot(merged);
}

export function createTestEngine(options: {
  ruleset?: BattleRuleset;
  formulas?: ResolvedCombatFormula;
  rng?: BattleRandom | number;
  systems?: boolean;
} = {}): BattleEngine {
  const rng = typeof options.rng === "number" ? new SeededBattleRandom(options.rng) : options.rng;
  return new BattleEngine(options.ruleset ?? new PveBattleRuleset(), {
    combatFormulaProvider: new StaticCombatFormulaProvider(options.formulas ?? makeFormulas()),
    rng,
    runtimeSystems: options.systems === false ? [] : [new RuneSetRuntimeSystem(), new PassiveRuntimeSystem()],
  });
}

/** RNG returning a fixed sequence (cycled). */
export class ScriptedRandom implements BattleRandom {
  private index = 0;
  constructor(private readonly values: number[]) {}
  next(): number {
    const value = this.values[this.index % this.values.length];
    this.index += 1;
    return value;
  }
  snapshot() {
    return { seed: 0, state: this.index };
  }
}

export type TestUnitSpec = {
  id: string;
  side: string;
  skills: CharacterSkillDTO[];
  passives?: CharacterPassiveDTO[];
  stats?: Partial<StatsDTO>;
  element?: string;
  turnBar?: number;
  line?: "Frontline" | "Backline";
  skillLevels?: Record<string, number>;
  metadata?: Record<string, unknown>;
  isBoss?: boolean;
};

/** Builds a battle state from compact unit specs (stats are used as-is through `statsOverride`). */
export function buildBattleState(units: TestUnitSpec[], options: {
  battleId?: string;
  mode?: "pve" | "arena" | "boss" | "generic";
  metadata?: Record<string, unknown>;
  playerSide?: string;
  seed?: number | string;
  formulas?: ResolvedCombatFormula;
} = {}) {
  // Imported lazily to keep the helper free of circular test imports.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createBattleState } = require("../../src/modules/battle-core");
  const sides: string[] = [];
  for (const unit of units) if (!sides.includes(unit.side)) sides.push(unit.side);
  const playerSide = options.playerSide ?? sides[0];

  return createBattleState({
    battleId: options.battleId ?? "test-battle",
    mode: options.mode ?? "pve",
    rulesetId: "pve-default",
    combatFormula: options.formulas,
    seed: options.seed,
    units: units.map((unit) => ({
      unitId: unit.id,
      sideId: unit.side,
      character: makeCharacter({ id: unit.id, skills: unit.skills, passives: unit.passives, element: unit.element, stats: unit.stats }),
      statsOverride: makeStats(unit.stats),
      turnBar: unit.turnBar ?? 0,
      line: unit.line,
      skillLevels: unit.skillLevels,
      metadata: unit.metadata,
      isBoss: unit.isBoss,
    })),
    teams: sides.map((sideId) => ({ sideId, isPlayerControlled: sideId === playerSide })),
    metadata: {
      playerSideId: playerSide,
      enemySideId: sides.find((side) => side !== playerSide),
      ...(options.metadata ?? {}),
    },
  });
}

/** Starts the battle and starts the turn of `actorId` (which must be ready). */
export function startTurnOf(engine: BattleEngine, state: any, actorId: string) {
  const started = state.phase === "created" ? engine.start(state).state : state;
  return engine.dispatch(started, { type: "start_turn", actorId });
}

export function eventsOfType<T extends string>(events: any[], type: T): any[] {
  return events.filter((event) => event.type === type);
}
