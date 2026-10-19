import {
  ArenaBattleRuleset,
  BattleEngine,
  BossBattleRuleset,
  PassiveRuntimeSystem,
  PveBattleRuleset,
  PveBattleSession,
  RuneSetRuntimeSystem,
  SeededBattleRandom,
  StaticCombatFormulaProvider,
  createDefaultCombatFormulaSnapshot,
  normalizeCombatFormulaSnapshot,
  type BattleActiveStatus,
  type BattleState,
  type BattleUnitState,
  type CharacterPassiveDTO,
  type CharacterSkillDTO,
  type ResolvedCombatFormula,
  type SkillEffectDTO,
} from "../../src/modules/battle-core";
import { buildBattleState, makeEffect, makeSkill, statusEffect, type TestUnitSpec } from "../helpers/battle-test-kit";

/** A player-level step of a parity scenario. `auto*` repeats auto-play until the battle ends. */
export type ParityCommand =
  | { type: "start" }
  | { type: "skill"; actorId: string; skillId: string; targetId: string }
  | { type: "auto" }
  | { type: "auto*"; max?: number }
  | { type: "surrender" };

export type ParityScenario = {
  name: string;
  description: string;
  rulesetId: "pve-default" | "arena-default" | "boss-default";
  formula: ResolvedCombatFormula;
  initialState: BattleState;
  playerSideId: string;
  enemySideId: string;
  totalWaves: number;
  pendingEnemyWaves: BattleUnitState[][];
  script: ParityCommand[];
};

const ELEMENTS = ["fire", "water", "wind", "light", "dark"];

function formula(overrides: Record<string, any> = {}): ResolvedCombatFormula {
  const base = createDefaultCombatFormulaSnapshot() as any;
  const merged: Record<string, any> = { ...base };
  for (const section of ["timing", "accuracy", "damage", "healing", "revive", "elements", "statusDefaults", "turnOrder"]) {
    merged[section] = { ...(base[section] ?? {}), ...(overrides[section] ?? {}) };
  }
  return normalizeCombatFormulaSnapshot(merged);
}

function status(overrides: Partial<BattleActiveStatus>): BattleActiveStatus {
  return {
    status: "AttackUp",
    remainingTurns: 2,
    magnitude: 0,
    percentPerTurn: 0,
    isBuff: true,
    isDispellable: true,
    stacks: 1,
    maxStacks: 1,
    uniqueTag: null,
    sourceId: null,
    value: null,
    skipNextTick: false,
    passiveId: null,
    ...overrides,
  };
}

function dmg(multiplier: number, extra: Partial<SkillEffectDTO> = {}): SkillEffectDTO {
  return makeEffect({ damageTerms: [{ source: "Attack", multiplier }], ...extra });
}

function waveUnits(specs: TestUnitSpec[], formulas: ResolvedCombatFormula): BattleUnitState[] {
  const state = buildBattleState([{ id: "__template__", side: "__none__", skills: [] }, ...specs], { formulas });
  return specs.map((spec) => state.units[spec.id]);
}

function scenario(params: {
  name: string;
  description: string;
  rulesetId?: ParityScenario["rulesetId"];
  formula?: ResolvedCombatFormula;
  players: TestUnitSpec[];
  enemies: TestUnitSpec[];
  waves?: TestUnitSpec[][];
  metadata?: Record<string, unknown>;
  seed?: string | number;
  mutate?: (state: BattleState) => void;
  script?: ParityCommand[];
}): ParityScenario {
  const formulas = params.formula ?? formula();
  const waves = params.waves ?? [];
  const state = buildBattleState([...params.players, ...params.enemies], {
    battleId: params.name,
    seed: params.seed ?? params.name,
    formulas,
    metadata: { totalWaves: waves.length + 1, currentWaveIndex: 0, ...(params.metadata ?? {}) },
  });
  params.mutate?.(state);
  return {
    name: params.name,
    description: params.description,
    rulesetId: params.rulesetId ?? "pve-default",
    formula: formulas,
    initialState: state,
    playerSideId: params.players[0].side,
    enemySideId: params.enemies[0].side,
    totalWaves: waves.length + 1,
    pendingEnemyWaves: waves.map((wave) => waveUnits(wave, formulas)),
    script: params.script ?? [{ type: "start" }, { type: "auto*" }],
  };
}

/** Builds the engine used for a scenario (same wiring as the server engine). */
export function createParityEngine(scenario: Pick<ParityScenario, "rulesetId" | "formula">): BattleEngine {
  const ruleset = scenario.rulesetId === "arena-default"
    ? new ArenaBattleRuleset()
    : scenario.rulesetId === "boss-default"
      ? new BossBattleRuleset()
      : new PveBattleRuleset();
  return new BattleEngine(ruleset, {
    combatFormulaProvider: new StaticCombatFormulaProvider(scenario.formula),
    runtimeSystems: [new RuneSetRuntimeSystem(), new PassiveRuntimeSystem()],
  });
}

export function createParitySession(scenario: ParityScenario): PveBattleSession {
  return new PveBattleSession({
    state: structuredClone(scenario.initialState),
    pendingEnemyWaves: structuredClone(scenario.pendingEnemyWaves),
    playerSideId: scenario.playerSideId,
    enemySideId: scenario.enemySideId,
    currentWaveIndex: 0,
    totalWaves: scenario.totalWaves,
    engine: createParityEngine(scenario),
  });
}

/* ------------------------------------------------------------------ authored scenarios */

const basic = makeSkill("basic", [dmg(1.2)]);

function handcrafted(): ParityScenario[] {
  const out: ParityScenario[] = [];

  out.push(scenario({
    name: "waves_elements_crits",
    description: "Three waves, element advantage/disadvantage, crits, crushing and glancing hits, misses.",
    players: [
      { id: "p_fire", side: "players", element: "fire", skills: [basic, makeSkill("blaze", [dmg(2.4)], { cooldownByLevel: [3] })], stats: { spd: 115, cr: 0.35, acc: 0.1 } },
      { id: "p_water", side: "players", element: "water", skills: [basic, makeSkill("tide", [dmg(1.1)], { targeting: "AllEnemies", cooldownByLevel: [4] })], stats: { spd: 104, cr: 0.2 } },
      { id: "p_wind", side: "players", element: "wind", skills: [basic], stats: { spd: 98, cr: 0.5, cd: 2 } },
    ],
    enemies: [
      { id: "e1_a", side: "enemies", element: "wind", skills: [basic], stats: { hp: 800, spd: 90, eva: 0.1 } },
      { id: "e1_b", side: "enemies", element: "water", skills: [basic], stats: { hp: 800, spd: 95 } },
    ],
    waves: [
      [{ id: "e2_a", side: "enemies", element: "fire", skills: [basic, makeSkill("smash", [dmg(2)], { cooldownByLevel: [3] })], stats: { hp: 1200, spd: 100 } }],
      [{ id: "e3_boss", side: "enemies", element: "dark", skills: [basic, makeSkill("void", [dmg(1.5)], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { hp: 2500, atk: 130, spd: 108 } }],
    ],
  }));

  out.push(scenario({
    name: "status_catalog",
    description: "DoT stacks, bombs, shields, stun, provoke, silence, oblivion, brand, glancing, stat buffs, immunity, invincibility, endure, counter, reflect, regen, heal block, beneficial block.",
    formula: formula({ accuracy: { baseHitChance: 0.95 } }),
    players: [
      { id: "p_dot", side: "players", element: "fire", skills: [
        makeSkill("burn", [dmg(1), statusEffect("ContinuousDamage", 2, { applyChance: 0.8 })]),
        makeSkill("bomb", [dmg(0.8), statusEffect("Bomb", 2)], { cooldownByLevel: [3] }),
        makeSkill("seal", [dmg(1), statusEffect("Silence", 2, { applyChance: 0.7 }), statusEffect("Oblivion", 2, { applyChance: 0.7 })], { cooldownByLevel: [4] }),
      ], stats: { spd: 120, acc: 0.25 } },
      { id: "p_tank", side: "players", element: "water", skills: [
        makeSkill("taunt", [dmg(0.9), statusEffect("Provoke", 1)]),
        makeSkill("fortify", [statusEffect("Shield", 2), statusEffect("DefenseUp", 2), statusEffect("Counterattack", 2, { target: "Self" })], { targeting: "AllAllies", cooldownByLevel: [4] }),
        makeSkill("mirror", [statusEffect("ReflectDamage", 2), statusEffect("Endure", 1)], { targetSide: "Self", cooldownByLevel: [3] }),
      ], stats: { hp: 1600, def: 160, spd: 100 } },
      { id: "p_sup", side: "players", element: "light", skills: [
        makeSkill("brand", [dmg(1), statusEffect("Brand", 2), statusEffect("Glancing", 2)]),
        makeSkill("rally", [statusEffect("AttackUp", 2), statusEffect("SpeedUp", 2), statusEffect("HpRegen", 2)], { targeting: "AllAllies", cooldownByLevel: [3] }),
        makeSkill("halo", [statusEffect("Immunity", 1), statusEffect("Invincibility", 1)], { targeting: "AllAllies", cooldownByLevel: [5] }),
      ], stats: { spd: 110 } },
    ],
    enemies: [
      { id: "e_stun", side: "enemies", element: "wind", skills: [basic, makeSkill("quake", [dmg(1), statusEffect("Stun", 1, { applyChance: 0.6 })], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { hp: 1800, spd: 105, acc: 0.2 } },
      { id: "e_debuff", side: "enemies", element: "dark", skills: [
        makeSkill("hex", [dmg(1), statusEffect("HealBlock", 2), statusEffect("BeneficialBlock", 2), statusEffect("Slow", 2), statusEffect("AttackBreak", 2), statusEffect("DefenseBreak", 2)]),
        makeSkill("drain", [dmg(1.4), makeEffect({ type: "Strip", damageTerms: [], buffCount: 1 }), makeEffect({ type: "StealBuffs", damageTerms: [], buffCount: 1 })], { cooldownByLevel: [3] }),
      ], stats: { hp: 1700, spd: 99, res: 0.3 } },
      { id: "e_freeze", side: "enemies", element: "water", skills: [basic, makeSkill("frost", [dmg(1.3), statusEffect("Freeze", 1), statusEffect("Sleep", 1)], { cooldownByLevel: [4] })], stats: { hp: 1500, spd: 93 } },
    ],
    mutate: (state) => {
      state.units.e_debuff.statuses.push(status({ status: "Counterattack", remainingTurns: 3, sourceId: "e_debuff" }));
      state.units.p_tank.statuses.push(status({ status: "ContinuousDamage", isBuff: false, remainingTurns: 2, percentPerTurn: 0.05, sourceId: "e_stun" }));
    },
  }));

  out.push(scenario({
    name: "multi_hit_targeting",
    description: "Multi-hit with applyEverySplit, RandomEnemies, AllAllies, per-effect scopes, conditions, frontline/backline restrictions.",
    players: [
      { id: "p_multi", side: "players", element: "wind", skills: [
        makeSkill("flurry", [dmg(0.5, { hits: 3 }), statusEffect("ContinuousDamage", 2, { applyEverySplit: true, applyChance: 0.5 })], { allowedLine: "FrontlineOnly" }),
        makeSkill("scatter", [dmg(0.7, { hits: 2 })], { targeting: "RandomEnemies", randomTargetCount: 2, cooldownByLevel: [3] }),
        makeSkill("snipe", [dmg(1.6), makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 0.3, target: "Self", condition: "OnCrit" })], { allowedLine: "BacklineOnly", cooldownByLevel: [2] }),
      ], stats: { spd: 125, cr: 0.4 }, line: "Frontline" },
      { id: "p_heal", side: "players", element: "water", skills: [
        makeSkill("splash", [dmg(1), makeEffect({ type: "Heal", damageTerms: [], healScale: 0.12, target: "LowestHpAlly" })]),
        makeSkill("mend", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.25 }), makeEffect({ type: "Cleanse", damageTerms: [], buffCount: 0 })], { targeting: "AllAllies", cooldownByLevel: [3] }),
        makeSkill("execute", [dmg(1.2), statusEffect("Stun", 1, { condition: "TargetHpBelow", conditionValue: 0.5 })], { cooldownByLevel: [3] }),
      ], stats: { spd: 105 }, line: "Backline" },
    ],
    enemies: [
      { id: "e_front1", side: "enemies", element: "fire", skills: [basic, makeSkill("cleave", [dmg(0.8, { hits: 2 }), statusEffect("DefenseBreak", 2, { applyEverySplit: true })], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { hp: 1300, spd: 100 }, line: "Frontline" },
      { id: "e_front2", side: "enemies", element: "light", skills: [basic, makeSkill("smite", [dmg(1.3), makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.4 })], { cooldownByLevel: [3] })], stats: { hp: 1300, spd: 97 }, line: "Frontline" },
      { id: "e_back", side: "enemies", element: "dark", skills: [basic, makeSkill("curse", [dmg(0.9), makeEffect({ type: "CooldownChange", damageTerms: [], cooldownTurns: 1 })], { cooldownByLevel: [2] })], stats: { hp: 1000, spd: 103 }, line: "Backline" },
    ],
  }));

  const reviveSelf: CharacterPassiveDTO = {
    id: "phoenix",
    triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.4 })] }],
  };
  out.push(scenario({
    name: "passives_runes",
    description: "Passive triggers (battle start, turn start, attack, damaged, death revive) and rune set specials.",
    formula: formula({ revive: { shieldPercentOnRevive: 0.1, turnBarPercentOnRevive: 0.2 } }),
    metadata: { turnLimit: 80 },
    players: [
      { id: "p_violent", side: "players", element: "fire", skills: [basic, makeSkill("burst", [dmg(2.2)], { cooldownByLevel: [3] })], stats: { spd: 118, cr: 0.3 },
        metadata: { runeSetEffects: { extraTurnChance: 0.22, lifestealPercent: 0.35 } },
        passives: [{ id: "focus", triggers: [
          { trigger: "OnTurnStart", chance: 0.5, target: "Self", effects: [statusEffect("CritRateUp", 1)] },
          { trigger: "OnAttack", chance: 0.4, target: "PrimaryTarget", effects: [statusEffect("DefenseBreak", 2)] },
        ] }] },
      { id: "p_despair", side: "players", element: "wind", skills: [makeSkill("jab", [dmg(0.6, { hits: 2 })]), makeSkill("gust", [dmg(1)], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { spd: 108, acc: 0.3 },
        metadata: { runeSetEffects: { stunOnHitChance: 0.25, destroyMaxHpPercentPerHit: 0.3, startOfBattleImmunityTurns: 1 } } },
      { id: "p_phoenix", side: "players", element: "light", skills: [basic], stats: { hp: 900, spd: 101 }, passives: [reviveSelf],
        metadata: { runeSetEffects: { counterattackChance: 0.3, atbGainPerHpLostPercent: 1 } } },
    ],
    enemies: [
      { id: "e_guard", side: "enemies", element: "water", skills: [basic, makeSkill("crush", [dmg(1.8)], { cooldownByLevel: [3] })], stats: { hp: 2200, spd: 100 },
        passives: [{ id: "thorns", triggers: [
          { trigger: "OnDamaged", chance: 0.5, target: "Attacker", effects: [statusEffect("Slow", 1)] },
          { trigger: "OnBattleStart", chance: 1, target: "AllAllies", effects: [statusEffect("DefenseUp", 2)] },
        ] }],
        metadata: { runeSetEffects: { counterattackChance: 0.25 } } },
      { id: "e_rogue", side: "enemies", element: "dark", skills: [basic, makeSkill("venom", [dmg(1), statusEffect("ContinuousDamage", 3), statusEffect("ContinuousDamage", 3)], { cooldownByLevel: [2] })], stats: { hp: 1500, spd: 106, acc: 0.2 },
        passives: [reviveSelf] },
    ],
  }));

  out.push(scenario({
    name: "support_ai_priorities",
    description: "Enemy healer AI: revive, heal below 50%, cleanse, buffs; player auto-play.",
    players: [
      { id: "p_dps1", side: "players", element: "fire", skills: [basic, makeSkill("nova", [dmg(1.3), statusEffect("AttackBreak", 2)], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { atk: 140, spd: 112, cr: 0.3 } },
      { id: "p_dps2", side: "players", element: "dark", skills: [basic, makeSkill("pierce", [dmg(2.6)], { cooldownByLevel: [3] })], stats: { atk: 150, spd: 107 } },
    ],
    enemies: [
      { id: "e_priest", side: "enemies", element: "light", skills: [
        makeSkill("wand", [dmg(0.8)]),
        makeSkill("heal", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.3 })], { cooldownByLevel: [2] }),
        makeSkill("purify", [makeEffect({ type: "Cleanse", damageTerms: [], buffCount: 0 }), statusEffect("DefenseUp", 2)], { targeting: "AllAllies", cooldownByLevel: [3] }),
        makeSkill("resurrect", [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })], { cooldownByLevel: [4] }),
      ], stats: { hp: 1400, spd: 109 } },
      { id: "e_knight", side: "enemies", element: "water", skills: [basic, makeSkill("bash", [dmg(1.5), statusEffect("Stun", 1, { applyChance: 0.4 })], { cooldownByLevel: [3] })], stats: { hp: 1600, spd: 98, def: 140 } },
      { id: "e_archer", side: "enemies", element: "wind", skills: [basic], stats: { hp: 1000, spd: 115 } },
    ],
  }));

  out.push(scenario({
    name: "player_commands_rejections",
    description: "Explicit player commands, rejected commands (provoke, cooldown, wrong side), then surrender.",
    players: [
      { id: "p1", side: "players", element: "fire", skills: [basic, makeSkill("big", [dmg(3)], { cooldownByLevel: [3] }), makeSkill("guard", [statusEffect("DefenseUp", 2)], { targetSide: "Ally" })], stats: { spd: 140 } },
      { id: "p2", side: "players", element: "water", skills: [basic], stats: { spd: 90 } },
    ],
    enemies: [
      { id: "e1", side: "enemies", element: "wind", skills: [basic], stats: { hp: 3000, spd: 80 } },
      { id: "e2", side: "enemies", element: "fire", skills: [basic], stats: { hp: 3000, spd: 70 } },
    ],
    mutate: (state) => {
      state.units.p1.statuses.push(status({ status: "Provoke", isBuff: false, remainingTurns: 1, sourceId: "e2" }));
    },
    script: [
      { type: "start" },
      { type: "skill", actorId: "p1", skillId: "big", targetId: "e1" },
      { type: "skill", actorId: "p1", skillId: "basic", targetId: "e1" },
      { type: "skill", actorId: "p2", skillId: "basic", targetId: "e1" },
      { type: "skill", actorId: "p1", skillId: "basic", targetId: "e2" },
      { type: "auto" },
      { type: "skill", actorId: "p1", skillId: "guard", targetId: "e1" },
      { type: "auto" },
      { type: "auto" },
      { type: "skill", actorId: "p1", skillId: "big", targetId: "e1" },
      { type: "auto" },
      { type: "surrender" },
      { type: "auto" },
    ],
  }));

  out.push(scenario({
    name: "arena_turn_limit_matrix",
    description: "Arena ruleset with a custom element matrix, linear resistance model and a turn limit draw.",
    rulesetId: "arena-default",
    formula: formula({
      accuracy: { debuffResistanceModel: "linear", accuracyVsResistanceWeight: 1, minimumDebuffChance: 0.1, maximumDebuffChance: 0.9 },
      damage: { useCriticalDamageStat: true, elementalAdvantageDamageMultiplier: 1.1, elementalDisadvantageDamageMultiplier: 0.9 },
      elements: { ids: ["red", "blue", "green"], matrix: [0, -1, 1, 1, 0, -1, -1, 1, 0] },
    }),
    metadata: { turnLimit: 18 },
    players: [
      { id: "blue_1", side: "blue", element: "blue", skills: [basic, makeSkill("drown", [dmg(1.1), statusEffect("Slow", 2)], { cooldownByLevel: [2] })], stats: { hp: 3000, spd: 100, cr: 0.3, cd: 1.8 } },
      { id: "blue_2", side: "blue", element: "green", skills: [basic, makeSkill("vines", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.15 })], { targeting: "AllAllies", cooldownByLevel: [3] })], stats: { hp: 3200, spd: 95 } },
    ],
    enemies: [
      { id: "red_1", side: "red", element: "red", skills: [basic, makeSkill("flare", [dmg(1.2), statusEffect("ContinuousDamage", 2)], { cooldownByLevel: [2] })], stats: { hp: 3100, spd: 99, cr: 0.25, cd: 1.7 } },
      { id: "red_2", side: "red", element: "blue", skills: [basic], stats: { hp: 3300, spd: 92, def: 150 } },
    ],
  }));

  out.push(scenario({
    name: "boss_ruleset",
    description: "Boss ruleset: boss side resolution with a turn limit (boss wins).",
    rulesetId: "boss-default",
    metadata: { bossSideId: "bosses", challengerSideId: "challengers", turnLimit: 12 },
    players: [
      { id: "c1", side: "challengers", element: "fire", skills: [basic, makeSkill("flame", [dmg(2)], { cooldownByLevel: [3] })], stats: { spd: 110 } },
      { id: "c2", side: "challengers", element: "light", skills: [basic], stats: { spd: 100 } },
    ],
    enemies: [
      { id: "boss", side: "bosses", element: "dark", skills: [basic, makeSkill("doom", [dmg(1), statusEffect("Bomb", 1)], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { hp: 9000, atk: 120, def: 150, spd: 95 } },
    ],
  }));

  // Skill-ups: cumulative per-level bonuses (damage, recovery, effect chance) at different unit skill levels.
  const levelBonuses = [
    { damagePct: 0, healPct: 0, effectChancePct: 0 },
    { damagePct: 5, healPct: 10, effectChancePct: 10 },
    { damagePct: 15, healPct: 20, effectChancePct: 25 },
  ];
  const leveled = (id: string, effects: SkillEffectDTO[], extra: Partial<CharacterSkillDTO> = {}) =>
    makeSkill(id, effects, { maxSkillLevel: 3, cooldownByLevel: [3, 3, 2], levelBonuses, ...extra });
  out.push(scenario({
    name: "skill_level_bonuses",
    description: "Skill levels scale damage terms / flat damage, heals and effect chances; cooldowns per level.",
    players: [
      { id: "p_lv3", side: "players", element: "fire", skills: [
        leveled("blaze", [dmg(1.1, { flatDamageBonus: 20 }), statusEffect("DefenseBreak", 2, { applyChance: 0.5 })], { cooldownByLevel: [0, 0, 0] }),
        leveled("inferno", [dmg(0.9), statusEffect("Stun", 1, { applyChance: 0.3 }), makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.3, baseChance: 0.6 })], { targeting: "AllEnemies" }),
      ], skillLevels: { blaze: 3, inferno: 2 }, stats: { spd: 112 } },
      { id: "p_heal", side: "players", element: "water", skills: [
        leveled("splash", [dmg(1.0)], { cooldownByLevel: [0, 0, 0] }),
        leveled("renew", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.15, flatHealBonus: 40 })], { targeting: "AllAllies", targetSide: "Ally" }),
      ], skillLevels: { splash: 1, renew: 3 }, stats: { spd: 104 } },
    ],
    enemies: [
      { id: "e_a", side: "enemies", element: "wind", skills: [basic, leveled("gust", [dmg(1.3), statusEffect("Slow", 2, { applyChance: 0.4 })])], skillLevels: { gust: 3 }, stats: { hp: 1800, spd: 101 } },
      { id: "e_b", side: "enemies", element: "dark", skills: [basic], stats: { hp: 1600, spd: 98 } },
    ],
  }));

  out.push(scenario({
    name: "kit_damage_actions",
    description: "Damage modifiers (target terms, scaling, ignore DEF, guaranteed crit, life steal, destroy with a 30% cap), AbsorbTurnBar, ExtraTurn on kill, AdditionalAttack, AllyAttack, TransferDebuffs, ChangeStatusDuration, irresistible / no-glancing, new statuses.",
    formula: formula({ accuracy: { baseHitChance: 0.9 }, damage: { destroyMaxHpCap: 0.3 } }),
    metadata: { turnLimit: 90 },
    players: [
      { id: "p_reaper", side: "players", element: "dark", skills: [
        makeSkill("reap", [dmg(0.8, { scaling: "TargetHpLow", scalingAmount: 1, lifeSteal: 0.3 }), makeEffect({ type: "ExtraTurn", damageTerms: [], condition: "OnKill" })]),
        makeSkill("siphon", [dmg(1, { ignoreDefense: 0.5, noGlancing: true }), makeEffect({ type: "AbsorbTurnBar", damageTerms: [], turnBarAmount: 0.3, baseChance: 0.8 }), makeEffect({ type: "TransferDebuffs", damageTerms: [], buffCount: 0 })], { cooldownByLevel: [3] }),
        makeSkill("frenzy", [dmg(0.6, { guaranteedCrit: true, critDamageBonus: 0.4 }), makeEffect({ type: "AdditionalAttack", damageTerms: [], baseChance: 0.6 }), makeEffect({ type: "AllyAttack", damageTerms: [], buffCount: 1 }), makeEffect({ type: "ExtraTurn", damageTerms: [], condition: "OnCrit", baseChance: 0.7 })], { cooldownByLevel: [4] }),
      ], stats: { spd: 120, cr: 0.3, acc: 0.2 } },
      { id: "p_breaker", side: "players", element: "fire", skills: [
        makeSkill("crush", [dmg(0.5, { damageTerms: [{ source: "Attack", multiplier: 0.5 }, { source: "TargetMaxHP", multiplier: 0.03 }], destroyMaxHp: 0.4 }), statusEffect("Unrevivable", 2, { irresistible: true, applyChance: 0.5 })]),
        makeSkill("quicken", [makeEffect({ type: "ChangeStatusDuration", damageTerms: [], isBuff: true, cooldownIncrease: true, cooldownTurns: 1 }), statusEffect("DamageReduction", 2), statusEffect("CritResistUp", 2), makeEffect({ type: "CooldownChange", damageTerms: [], cooldownIncrease: false, cooldownTurns: 1, buffCount: 2 })], { targeting: "AllAllies", cooldownByLevel: [3] }),
        makeSkill("rush", [dmg(0.7, { damageTerms: [{ source: "TargetSpeed", multiplier: 0.5 }, { source: "Attack", multiplier: 0.5 }], scaling: "CasterSpeed", scalingAmount: 0.5 })], { cooldownByLevel: [2] }),
      ], stats: { spd: 104, atk: 120 } },
      { id: "p_guard", side: "players", element: "water", skills: [
        makeSkill("bash", [dmg(0.9, { scaling: "TargetDebuffCount", scalingAmount: 0.3 }), statusEffect("Freeze", 1, { condition: "TargetHasDebuff" })]),
        makeSkill("taunt_all", [statusEffect("Threat", 2), statusEffect("DefenseUp", 2), statusEffect("InabilityImmunity", 2)], { targetSide: "Self", cooldownByLevel: [3] }),
        makeSkill("pierce", [dmg(1.2, { flatDamageBonus: 10 }), statusEffect("Stun", 1, { condition: "TargetIsNotBoss" }), statusEffect("AttackBreak", 2, { condition: "CasterStatHigher", conditionStat: "Defense", conditionValue: 1.1 })], { cooldownByLevel: [4] }),
      ], stats: { hp: 1500, spd: 98, def: 140 } },
    ],
    enemies: [
      { id: "e_brute", side: "enemies", element: "fire", isBoss: true, skills: [basic, makeSkill("rage", [statusEffect("Berserk", 2)], { targetSide: "Self", cooldownByLevel: [4] }), makeSkill("smash", [dmg(1.5, { scaling: "CasterHpLow", scalingAmount: 0.8 }), makeEffect({ type: "ChangeStatusDuration", damageTerms: [], isBuff: true, cooldownIncrease: false, cooldownTurns: 1, baseChance: 0.7 })], { cooldownByLevel: [3] })], stats: { hp: 2600, spd: 101 } },
      { id: "e_witch", side: "enemies", element: "light", skills: [basic, makeSkill("hex", [dmg(0.8), statusEffect("Slow", 2), statusEffect("Unrecoverable", 2), makeEffect({ type: "AbsorbTurnBar", damageTerms: [], turnBarAmount: 0.5, irresistible: true }), makeEffect({ type: "CooldownChange", damageTerms: [], cooldownTurns: 1, buffCount: 0 })], { cooldownByLevel: [3] })], stats: { hp: 1900, spd: 108, acc: 0.3 } },
      { id: "e_shield", side: "enemies", element: "water", skills: [basic, makeSkill("ward", [statusEffect("Threat", 2), statusEffect("DamageReduction", 2, { statusMagnitude: 0.5 })], { targetSide: "Self", cooldownByLevel: [4] })], stats: { hp: 2400, spd: 96, def: 150 },
        passives: [{ id: "spite", triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.3 })] }] }] },
    ],
    mutate: (state) => {
      state.units.e_shield.statuses.push(status({ status: "Unrevivable", isBuff: false, remainingTurns: 99, sourceId: "p_breaker" }));
    },
  }));

  out.push(scenario({
    name: "kit_passives_auras",
    description: "New passive triggers and targets (BeforeAttack, OnCrit, OnKill, OnAllyDeath, OnDebuffed, OnTurnEnd, LowestHpAlly, RandomEnemy), live auras (death, Oblivion, max HP), conditions.",
    metadata: { turnLimit: 90 },
    players: [
      { id: "p_lord", side: "players", element: "light", skills: [basic, makeSkill("decree", [dmg(1.1, { hits: 2 }), statusEffect("Oblivion", 2, { condition: "TargetHasNoDebuff" })], { cooldownByLevel: [3] })], stats: { hp: 1300, spd: 106 },
        passives: [{ id: "banner", triggers: [], auras: [
          { stat: "Attack", percent: 0.3, flat: 0, scope: "AllAllies", activeWhileAlive: true },
          { stat: "MaxHP", percent: 0.15, flat: 20, scope: "AllAllies", activeWhileAlive: true },
          { stat: "Speed", percent: 0, flat: -8, scope: "AllEnemies", activeWhileAlive: false },
        ] }] },
      { id: "p_blade", side: "players", element: "wind", skills: [basic, makeSkill("slash", [dmg(1.8, { scaling: "TargetHpHigh", scalingAmount: 0.5 }), statusEffect("Stun", 1, { condition: "CasterHpBelow", conditionValue: 0.6 }), statusEffect("Silence", 1, { condition: "TargetHasStatus", conditionStatus: "DefenseBreak" }), makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 0.2, target: "Self", condition: "CasterHasStatus", conditionStatus: "CritDamageUp" })], { cooldownByLevel: [3] })], stats: { spd: 112, cr: 0.45 },
        passives: [{ id: "edge", triggers: [
          { trigger: "BeforeAttack", chance: 0.6, target: "Self", effects: [statusEffect("CritDamageUp", 1)] },
          { trigger: "OnCrit", chance: 1, target: "RandomEnemy", effects: [statusEffect("DefenseBreak", 1)] },
          { trigger: "OnKill", chance: 1, target: "Self", effects: [makeEffect({ type: "ExtraTurn", damageTerms: [] })] },
        ] }] },
      { id: "p_monk", side: "players", element: "water", skills: [basic, makeSkill("chant", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.15 }), makeEffect({ type: "Cleanse", damageTerms: [], buffCount: 1, condition: "TargetHasDebuff" })], { targeting: "AllAllies", cooldownByLevel: [3] })], stats: { spd: 100 },
        passives: [{ id: "calm", triggers: [
          { trigger: "OnTurnEnd", chance: 1, target: "LowestHpAlly", effects: [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.05 })], maxPerBattle: 3 },
          { trigger: "OnAllyDeath", chance: 1, target: "AllAllies", effects: [statusEffect("AttackUp", 2)] },
          { trigger: "OnHealed", chance: 0.5, target: "Self", effects: [statusEffect("DefenseUp", 1)] },
        ] }] },
    ],
    enemies: [
      { id: "e_chief", side: "enemies", element: "dark", skills: [basic, makeSkill("roar", [statusEffect("AttackUp", 2), statusEffect("CritRateUp", 2)], { targeting: "AllAllies", cooldownByLevel: [3] })], stats: { hp: 2200, spd: 103 },
        passives: [{ id: "warband", triggers: [{ trigger: "OnDebuffed", chance: 0.5, target: "Self", effects: [makeEffect({ type: "Cleanse", damageTerms: [], buffCount: 1 })] }], auras: [
          { stat: "Defense", percent: 0.25, flat: 0, scope: "AllAllies", activeWhileAlive: true },
          { stat: "CritRate", percent: 0.1, flat: 0, scope: "Self", activeWhileAlive: true, elementFilter: ["dark"] },
        ] }] },
      { id: "e_imp", side: "enemies", element: "fire", skills: [basic, makeSkill("ember", [dmg(1), statusEffect("ContinuousDamage", 2)], { cooldownByLevel: [2] })], stats: { hp: 1300, spd: 110 },
        passives: [{ id: "mourn", triggers: [
          { trigger: "OnAllyDeath", chance: 1, target: "Attacker", effects: [statusEffect("Slow", 2)] },
          { trigger: "OnCritReceived", chance: 1, target: "Attacker", effects: [statusEffect("Glancing", 1)], cooldown: 2 },
          { trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.4 })], cooldown: 3, maxPerBattle: 1 },
        ] }] },
    ],
    waves: [
      [{ id: "e_boss", side: "enemies", element: "light", skills: [basic, makeSkill("judge", [dmg(1.2, { scaling: "CasterBuffCount", scalingAmount: 0.2 }), makeEffect({ type: "TransferDebuffs", damageTerms: [], buffCount: 1 })], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { hp: 4200, atk: 120, spd: 99 },
        passives: [{ id: "aegis", triggers: [{ trigger: "OnTurnStart", chance: 1, target: "Self", effects: [statusEffect("CritResistUp", 1)] }], auras: [{ stat: "Resistance", percent: 0.2, flat: 0, scope: "Self", activeWhileAlive: true }] }] }],
    ],
  }));

  out.push(scenario({
    name: "kit_scripted_threat_kills",
    description: "Threat rejection, AoE kills with an Unrevivable revive passive (revive_blocked) and an OnKill passive extra turn.",
    formula: formula({ accuracy: { baseHitChance: 1 } }),
    players: [
      { id: "p_killer", side: "players", element: "light", skills: [basic, makeSkill("sweep", [dmg(1)], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { atk: 400, spd: 200 },
        passives: [{ id: "bloodlust", triggers: [{ trigger: "OnKill", chance: 1, target: "Self", effects: [makeEffect({ type: "ExtraTurn", damageTerms: [] })] }] }] },
      { id: "p_two", side: "players", element: "light", skills: [basic], stats: { spd: 90 } },
    ],
    enemies: [
      { id: "e_tank", side: "enemies", element: "light", skills: [basic], stats: { hp: 3000, spd: 80 } },
      { id: "e_weak", side: "enemies", element: "light", skills: [basic], stats: { hp: 200, spd: 70 },
        passives: [{ id: "undying", triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })] }] }] },
      { id: "e_weak2", side: "enemies", element: "light", skills: [basic], stats: { hp: 200, spd: 60 } },
    ],
    mutate: (state) => {
      state.units.e_tank.statuses.push(status({ status: "Threat", remainingTurns: 3, sourceId: "e_tank" }));
      state.units.e_weak.statuses.push(status({ status: "Unrevivable", isBuff: false, remainingTurns: 3, sourceId: "p_killer" }));
    },
    script: [
      { type: "start" },
      { type: "skill", actorId: "p_killer", skillId: "basic", targetId: "e_weak" },
      { type: "skill", actorId: "p_killer", skillId: "sweep", targetId: "e_tank" },
      { type: "auto*" },
    ],
  }));

  out.push(scenario({
    name: "kit_passive_limits",
    description: "Passive trigger cooldowns / max per battle and the once-per-action safety net (death / revive ping-pong).",
    formula: formula({ accuracy: { baseHitChance: 1 } }),
    metadata: { turnLimit: 60 },
    players: [
      { id: "p_reaper", side: "players", element: "light", skills: [basic, makeSkill("doom", [dmg(1, { damageTerms: [], flatDamageBonus: 4000 }), makeEffect({ type: "AdditionalAttack", damageTerms: [] })], { cooldownByLevel: [4] })], stats: { spd: 200 } },
      { id: "p_two", side: "players", element: "light", skills: [basic], stats: { spd: 95 } },
    ],
    enemies: [
      { id: "e_phoenix", side: "enemies", element: "light", skills: [basic], stats: { hp: 1500, spd: 90 },
        passives: [{ id: "rebirth", triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })] }] }] },
      { id: "e_tank", side: "enemies", element: "light", skills: [basic], stats: { hp: 3000, spd: 85 },
        passives: [{ id: "bulwark", triggers: [
          { trigger: "OnDamaged", chance: 1, target: "Self", effects: [statusEffect("DefenseUp", 1)], cooldown: 2, maxPerBattle: 2 },
          { trigger: "OnAllyDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1 })], cooldown: 1 },
        ] }] },
    ],
    script: [
      { type: "start" },
      { type: "skill", actorId: "p_reaper", skillId: "doom", targetId: "e_phoenix" },
      { type: "auto*" },
    ],
  }));

  // A skill that resets the caster's cooldowns and grants an extra turn (game data raptor_*_s3): its own cooldown is kept,
  // so the extra-turn chain ends (it used to loop until the session step budget ran out).
  out.push(scenario({
    name: "kit_self_cooldown_reset",
    description: "Self CooldownChange decrease (all skills) + ExtraTurn: the skill keeps its own cooldown, the others reset.",
    metadata: { turnLimit: 80 },
    players: [
      { id: "p_raptor", side: "players", element: "light", skills: [
        basic,
        makeSkill("pounce", [dmg(1.6)], { cooldownByLevel: [3] }),
        makeSkill("frenzy", [
          makeEffect({ type: "Cleanse", damageTerms: [], buffCount: 0, target: "Self" }),
          makeEffect({ type: "Heal", damageTerms: [], healScale: 1, target: "Self" }),
          makeEffect({ type: "CooldownChange", damageTerms: [], cooldownIncrease: false, cooldownTurns: 5, buffCount: 0, target: "Self" }),
          statusEffect("AttackUp", 99, { target: "Self" }),
          makeEffect({ type: "ExtraTurn", damageTerms: [] }),
        ], { targetSide: "Self", cooldownByLevel: [4] }),
      ], stats: { spd: 115, hp: 3000 } },
      { id: "p_mate", side: "players", element: "water", skills: [basic], stats: { spd: 100 } },
    ],
    enemies: [
      { id: "e_raptor", side: "enemies", element: "dark", skills: [
        basic,
        makeSkill("crush", [dmg(1.8)], { cooldownByLevel: [4] }),
        makeSkill("rampage", [
          dmg(1.2),
          makeEffect({ type: "CooldownChange", damageTerms: [], cooldownIncrease: false, cooldownTurns: 5, buffCount: 0, target: "Self" }),
          makeEffect({ type: "ExtraTurn", damageTerms: [] }),
        ], { cooldownByLevel: [3] }),
      ], stats: { hp: 3500, spd: 112 } },
      { id: "e_brute", side: "enemies", element: "fire", skills: [basic], stats: { hp: 3000, spd: 95 } },
    ],
    mutate: (state) => {
      state.units.p_raptor.cooldowns = { pounce: 2 };
      state.units.e_raptor.cooldowns = { crush: 3 };
    },
  }));

  // A data error (a cooldown-free skill that always grants an extra turn) chains extra turns until the session step
  // budget runs out: the step reports AUTO_ADVANCE_STALLED and auto-play resumes the battle (here up to the turn limit).
  out.push(scenario({
    name: "session_stall_resume",
    description: "Endless AI extra-turn chain: the step budget stalls the session, auto-play resumes it until the turn limit.",
    metadata: { turnLimit: 520 },
    players: [
      { id: "p_wall", side: "players", element: "water", skills: [basic], stats: { hp: 900000, spd: 90 } },
    ],
    enemies: [
      { id: "e_loop", side: "enemies", element: "fire", skills: [
        makeSkill("loop", [makeEffect({ type: "ExtraTurn", damageTerms: [] })], { targetSide: "Self" }),
      ], stats: { hp: 900000, spd: 150 } },
    ],
    script: [{ type: "start" }, { type: "auto" }, { type: "auto" }],
  }));

  out.push(...turnOrderScenarios());
  return out;
}

/* ------------------------------------------------------------------ turn order modes */

type RoundMode = "SpeedRounds" | "AlternatingSides" | "TeamPhase";

const ROUND_MODES: RoundMode[] = ["SpeedRounds", "AlternatingSides", "TeamPhase"];

function modeTag(mode: RoundMode): string {
  return mode === "SpeedRounds" ? "rounds" : mode === "AlternatingSides" ? "alternating" : "phase";
}

/**
 * The same kit played under every round mode: attack bar boosts / cuts / absorb, SpeedUp / Slow, Freeze, Stun, DoT,
 * ExtraTurn, AdditionalAttack, AllyAttack, revive passive, counterattack, cooldowns and two waves.
 */
function turnOrderKitScenario(mode: RoundMode): ParityScenario {
  const tag = modeTag(mode);
  return scenario({
    name: `turn_${tag}_kit`,
    description: `${mode}: attack bar effects (bar capped at 200%), speed buffs, hard CC, DoT, extra turns, follow-ups, revive and waves.`,
    formula: formula({ turnOrder: { mode, roundModeTurnBarCap: 2 }, accuracy: { baseHitChance: 0.95 }, revive: { turnBarPercentOnRevive: 0.3 } }),
    metadata: { turnLimit: 110 },
    players: [
      { id: "p_haste", side: "players", element: "wind", skills: [
        basic,
        makeSkill("rally", [statusEffect("SpeedUp", 2), makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 0.5 })], { targeting: "AllAllies", targetSide: "Ally", cooldownByLevel: [3] }),
        makeSkill("tempo", [dmg(1.4), makeEffect({ type: "ExtraTurn", damageTerms: [], baseChance: 0.6 })], { cooldownByLevel: [3] }),
      ], stats: { spd: 128, atk: 190 } },
      { id: "p_frost", side: "players", element: "water", skills: [
        makeSkill("chill", [dmg(1), statusEffect("Slow", 2, { applyChance: 0.7 }), makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.4, baseChance: 0.8 })]),
        makeSkill("glacier", [dmg(0.9), statusEffect("Freeze", 1, { applyChance: 0.5 })], { targeting: "AllEnemies", cooldownByLevel: [4] }),
        makeSkill("siphon", [dmg(1.1), makeEffect({ type: "AbsorbTurnBar", damageTerms: [], turnBarAmount: 0.5 })], { cooldownByLevel: [3] }),
      ], stats: { spd: 104, atk: 170, acc: 0.3 } },
      { id: "p_duo", side: "players", element: "fire", skills: [
        basic,
        makeSkill("combo", [dmg(1.1), makeEffect({ type: "AdditionalAttack", damageTerms: [], baseChance: 0.5 }), makeEffect({ type: "AllyAttack", damageTerms: [], buffCount: 1 })], { cooldownByLevel: [3] }),
      ], stats: { spd: 97, atk: 180, cr: 0.3 }, passives: [{ id: "rebirth", triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.4 })] }] }] },
    ],
    enemies: [
      { id: "e_fast", side: "enemies", element: "fire", skills: [basic, makeSkill("burn", [dmg(1), statusEffect("ContinuousDamage", 2), makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 1, baseChance: 0.5 })], { cooldownByLevel: [3] })], stats: { hp: 1500, spd: 121, acc: 0.2 },
        metadata: { runeSetEffects: { extraTurnChance: 0.2, atbGainPerHpLostPercent: 1 } } },
      { id: "e_tank", side: "enemies", element: "wind", skills: [basic, makeSkill("bash", [dmg(1.2), statusEffect("Stun", 1, { applyChance: 0.5 })], { cooldownByLevel: [3] })], stats: { hp: 2200, spd: 92, def: 140 },
        metadata: { runeSetEffects: { counterattackChance: 0.2 } } },
    ],
    waves: [
      [
        { id: "e2_boss", side: "enemies", element: "dark", isBoss: true, skills: [basic, makeSkill("haste", [statusEffect("SpeedUp", 2), makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 1 })], { targeting: "AllAllies", targetSide: "Ally", cooldownByLevel: [4] }), makeSkill("doom", [dmg(1.3)], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { hp: 3800, atk: 125, spd: 101 },
          passives: [{ id: "spite", triggers: [{ trigger: "OnTurnStart", chance: 0.5, target: "Self", effects: [makeEffect({ type: "ExtraTurn", damageTerms: [] })] }] }] },
        { id: "e2_imp", side: "enemies", element: "light", skills: [basic, makeSkill("mend", [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })], { targetSide: "Ally", cooldownByLevel: [4] })], stats: { hp: 1300, spd: 113 } },
      ],
    ],
  });
}

/** TeamPhase: the player picks units out of the default order (explicit skill commands), then auto-play. */
function teamPhaseSelectionScenario(): ParityScenario {
  return scenario({
    name: "turn_phase_selection",
    description: "TeamPhase manual play: the player picks the slowest unit first, rejected picks, ATB cuts that make units skip the phase, auto.",
    formula: formula({ turnOrder: { mode: "TeamPhase", teamPhaseSkipThreshold: 0.25 }, accuracy: { baseHitChance: 1 } }),
    players: [
      { id: "p_a", side: "players", element: "fire", skills: [basic, makeSkill("boost", [makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 1 })], { targetSide: "Ally", cooldownByLevel: [3] })], stats: { spd: 130 } },
      { id: "p_b", side: "players", element: "water", skills: [basic, makeSkill("cut", [dmg(0.8), makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.5 })], { cooldownByLevel: [2] })], stats: { spd: 110, acc: 0.5 } },
      { id: "p_c", side: "players", element: "wind", skills: [basic], stats: { spd: 90 } },
    ],
    enemies: [
      { id: "e_a", side: "enemies", element: "wind", skills: [basic, makeSkill("slowdown", [dmg(0.9), makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.4 })], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { hp: 2600, spd: 125 } },
      { id: "e_b", side: "enemies", element: "fire", skills: [basic], stats: { hp: 2400, spd: 95 } },
    ],
    script: [
      { type: "start" },
      { type: "skill", actorId: "p_c", skillId: "basic", targetId: "e_b" },
      { type: "skill", actorId: "p_c", skillId: "basic", targetId: "e_b" },
      { type: "skill", actorId: "p_a", skillId: "boost", targetId: "p_c" },
      { type: "skill", actorId: "p_c", skillId: "basic", targetId: "e_a" },
      { type: "skill", actorId: "p_b", skillId: "cut", targetId: "e_a" },
      { type: "auto*", max: 200 },
    ],
  });
}

function turnOrderScenarios(): ParityScenario[] {
  return [...ROUND_MODES.map(turnOrderKitScenario), teamPhaseSelectionScenario()];
}

/* ------------------------------------------------------------------ generated scenarios */

function pick<T>(rng: SeededBattleRandom, values: T[]): T {
  return values[Math.floor(rng.next() * values.length)];
}

function int(rng: SeededBattleRandom, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const STATUS_POOL: Array<SkillEffectDTO["status"]> = [
  "ContinuousDamage", "Stun", "Slow", "AttackBreak", "DefenseBreak", "Brand", "Glancing", "Silence", "Provoke", "Bomb", "HealBlock", "Freeze", "Sleep", "Oblivion",
  "Unrevivable", "Unrecoverable",
];
const BUFF_POOL: Array<SkillEffectDTO["status"]> = [
  "AttackUp", "DefenseUp", "SpeedUp", "CritRateUp", "Shield", "Immunity", "Endure", "Counterattack", "ReflectDamage", "HpRegen", "Invincibility", "CritDamageUp",
  "DamageReduction", "CritResistUp", "Threat", "Berserk", "InabilityImmunity",
];
const SCALING_POOL: Array<NonNullable<SkillEffectDTO["scaling"]>> = [
  "TargetHpLow", "TargetHpHigh", "CasterHpLow", "CasterHpHigh", "TargetDebuffCount", "CasterBuffCount", "CasterSpeed",
];

/** Random kit extras on a damage effect (scaling, ignore DEF, crits, life steal, destroy, no glancing). */
function randomDamageExtras(rng: SeededBattleRandom): Partial<SkillEffectDTO> {
  if (rng.next() >= 0.4) return {};
  return {
    scaling: pick(rng, SCALING_POOL),
    scalingAmount: round2(0.2 + rng.next() * 0.8),
    ignoreDefense: rng.next() < 0.3 ? round2(rng.next()) : 0,
    guaranteedCrit: rng.next() < 0.2,
    critDamageBonus: rng.next() < 0.3 ? round2(rng.next() * 0.5) : 0,
    lifeSteal: rng.next() < 0.3 ? round2(rng.next() * 0.5) : 0,
    destroyMaxHp: rng.next() < 0.2 ? 0.3 : 0,
    noGlancing: rng.next() < 0.2,
  };
}

/** Random kit action effect (ATB absorb, extra turn, follow-up attacks, debuff transfer, duration change). */
function randomActionEffect(rng: SeededBattleRandom): SkillEffectDTO {
  switch (pick(rng, ["absorb", "extra", "again", "ally", "transfer", "duration"] as const)) {
    case "absorb": return makeEffect({ type: "AbsorbTurnBar", damageTerms: [], turnBarAmount: 0.25, baseChance: 0.8, irresistible: rng.next() < 0.3 });
    case "extra": return makeEffect({ type: "ExtraTurn", damageTerms: [], baseChance: 0.5, condition: pick(rng, ["Always", "OnKill", "OnCrit"] as const) });
    case "again": return makeEffect({ type: "AdditionalAttack", damageTerms: [], baseChance: 0.4 });
    case "ally": return makeEffect({ type: "AllyAttack", damageTerms: [], buffCount: 1, baseChance: 0.6 });
    case "transfer": return makeEffect({ type: "TransferDebuffs", damageTerms: [], buffCount: 1 });
    default: return makeEffect({ type: "ChangeStatusDuration", damageTerms: [], isBuff: rng.next() < 0.5, cooldownIncrease: rng.next() < 0.5, cooldownTurns: 1, baseChance: 0.8 });
  }
}

function randomSkill(rng: SeededBattleRandom, id: string, slot: number): CharacterSkillDTO {
  const cooldown = slot === 0 ? 0 : int(rng, 2, 5);
  const kind = slot === 0 ? "attack" : pick(rng, ["attack", "attack", "aoe", "debuff", "support", "multi"]);
  const effects: SkillEffectDTO[] = [];
  const skill: Partial<CharacterSkillDTO> = { cooldownByLevel: [cooldown, Math.max(0, cooldown - 1)], maxSkillLevel: 2 };

  switch (kind) {
    case "aoe":
      skill.targeting = pick(rng, ["AllEnemies", "CircleAroundTarget", "RandomEnemies"]);
      skill.randomTargetCount = int(rng, 1, 3);
      effects.push(dmg(round2(0.6 + rng.next())));
      if (rng.next() < 0.6) effects.push(statusEffect(pick(rng, STATUS_POOL), int(rng, 1, 2), { applyChance: round2(0.3 + rng.next() * 0.7) }));
      break;
    case "debuff":
      effects.push(dmg(round2(0.8 + rng.next())));
      effects.push(statusEffect(pick(rng, STATUS_POOL), int(rng, 1, 3), { applyChance: round2(0.4 + rng.next() * 0.6) }));
      if (rng.next() < 0.4) effects.push(makeEffect({ type: pick(rng, ["Strip", "TurnBar", "CooldownChange"] as const), damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.25, baseChance: 0.8 }));
      break;
    case "support":
      skill.targeting = pick(rng, ["AllAllies", "SingleTarget"]);
      skill.targetSide = "Ally";
      effects.push(statusEffect(pick(rng, BUFF_POOL), int(rng, 1, 3)));
      if (rng.next() < 0.5) effects.push(makeEffect({ type: pick(rng, ["Heal", "Cleanse", "TurnBar"] as const), damageTerms: [], healScale: 0.2, buffCount: 1, turnBarAmount: 0.2 }));
      if (rng.next() < 0.3) effects.push(makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.3 }));
      break;
    case "multi":
      effects.push(dmg(round2(0.4 + rng.next() * 0.5), { hits: int(rng, 2, 4) }));
      effects.push(statusEffect(pick(rng, STATUS_POOL), 2, { applyEverySplit: rng.next() < 0.5, applyChance: 0.3 }));
      if (rng.next() < 0.5) effects.push(statusEffect(pick(rng, BUFF_POOL), 1, { target: pick(rng, ["Self", "AllAllies", "LowestHpAlly"] as const), condition: pick(rng, ["Always", "OnCrit", "OnHit"] as const) }));
      break;
    default:
      effects.push(dmg(round2(0.9 + rng.next() * (slot === 0 ? 0.6 : 2)), { flatDamageBonus: int(rng, 0, 30), ...randomDamageExtras(rng) }));
      if (rng.next() < 0.3) effects.push(statusEffect(pick(rng, STATUS_POOL), 1, { applyChance: 0.5, condition: pick(rng, ["Always", "TargetHasDebuff", "TargetHasNoBuff", "TargetHasNoDebuff", "CasterHpBelow", "OnKill", "TargetIsNotBoss", "CasterStatHigher", "TargetHasStatus"] as const), conditionValue: 0.5, conditionStat: pick(rng, ["Attack", "Defense", "Speed", "MaxHP", "HpRatio"] as const), conditionStatus: pick(rng, STATUS_POOL) }));
      if (slot > 0 && rng.next() < 0.35) effects.push(randomActionEffect(rng));
  }

  if (rng.next() < 0.15) skill.allowedLine = pick(rng, ["FrontlineOnly", "BacklineOnly"]);
  return makeSkill(id, effects, skill);
}

function randomUnit(rng: SeededBattleRandom, id: string, side: string, strength: number): TestUnitSpec {
  const skillCount = int(rng, 1, 3);
  const skills: CharacterSkillDTO[] = [];
  for (let i = 0; i < skillCount; i++) skills.push(randomSkill(rng, `${id}_s${i + 1}`, i));

  const spec: TestUnitSpec = {
    id,
    side,
    element: pick(rng, ELEMENTS),
    skills,
    line: rng.next() < 0.5 ? "Frontline" : "Backline",
    skillLevels: Object.fromEntries(skills.map((skill) => [skill.id, int(rng, 1, 2)])),
    stats: {
      hp: Math.round((900 + int(rng, 0, 900)) * strength),
      atk: Math.round((80 + int(rng, 0, 70)) * strength),
      def: 60 + int(rng, 0, 90),
      spd: 85 + int(rng, 0, 40),
      cr: round2(rng.next() * 0.5),
      cd: round2(1.5 + rng.next()),
      res: round2(rng.next() * 0.5),
      acc: round2(rng.next() * 0.5),
      eva: round2(rng.next() * 0.1),
    },
  };

  if (rng.next() < 0.25) {
    spec.metadata = { runeSetEffects: {
      extraTurnChance: rng.next() < 0.5 ? 0.22 : 0,
      stunOnHitChance: rng.next() < 0.5 ? 0.25 : 0,
      counterattackChance: rng.next() < 0.5 ? 0.15 : 0,
      lifestealPercent: rng.next() < 0.5 ? 0.35 : 0,
      atbGainPerHpLostPercent: rng.next() < 0.5 ? 1 : 0,
      destroyMaxHpPercentPerHit: rng.next() < 0.3 ? 0.3 : 0,
      startOfBattleImmunityTurns: rng.next() < 0.3 ? 1 : 0,
    } };
  }

  if (rng.next() < 0.3) {
    spec.passives = [{
      id: `${id}_passive`,
      triggers: [{
        trigger: pick(rng, ["OnBattleStart", "OnTurnStart", "OnAttack", "OnDamaged", "OnDeath", "OnTurnEnd", "OnCrit", "OnKill", "OnAllyDeath", "OnDebuffed", "BeforeAttack", "OnCritReceived", "OnHealed"] as const),
        chance: round2(0.3 + rng.next() * 0.7),
        target: pick(rng, ["Self", "AllAllies", "PrimaryTarget", "Attacker", "AllEnemies", "LowestHpAlly", "RandomEnemy"] as const),
        effects: [rng.next() < 0.5 ? statusEffect(pick(rng, BUFF_POOL), 1) : makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1 })],
        cooldown: rng.next() < 0.3 ? int(rng, 1, 3) : 0,
        maxPerBattle: rng.next() < 0.3 ? int(rng, 1, 2) : 0,
      }],
      auras: rng.next() < 0.5
        ? [{
            stat: pick(rng, ["MaxHP", "Attack", "Defense", "Speed", "CritRate", "CritDamage", "Resistance", "Accuracy", "Evasion"] as const),
            percent: round2(rng.next() * 0.3),
            flat: rng.next() < 0.3 ? int(rng, 1, 20) : 0,
            scope: pick(rng, ["Self", "AllAllies", "AllEnemies"] as const),
            activeWhileAlive: rng.next() < 0.8,
          }]
        : [],
    }];
  }

  return spec;
}

function generated(count: number, mode: RoundMode | null = null): ParityScenario[] {
  const out: ParityScenario[] = [];
  for (let index = 0; index < count; index++) {
    const rng = new SeededBattleRandom(mode ? `parity-generated-${modeTag(mode)}-${index}` : `parity-generated-${index}`);
    const players: TestUnitSpec[] = [];
    const playerCount = int(rng, 2, 4);
    for (let i = 0; i < playerCount; i++) players.push(randomUnit(rng, `p${i + 1}`, "players", 1.1));

    const waveCount = int(rng, 1, 3);
    const waves: TestUnitSpec[][] = [];
    for (let w = 0; w < waveCount; w++) {
      const wave: TestUnitSpec[] = [];
      const enemyCount = int(rng, 1, 3);
      for (let i = 0; i < enemyCount; i++) wave.push(randomUnit(rng, `w${w + 1}_e${i + 1}`, "enemies", 0.8 + w * 0.2));
      waves.push(wave);
    }

    const [firstWave, ...rest] = waves;
    out.push(scenario({
      name: mode ? `generated_${modeTag(mode)}_${String(index).padStart(2, "0")}` : `generated_${String(index).padStart(2, "0")}`,
      description: mode
        ? `Randomly generated battle (deterministic generator) played with auto-play, turn order ${mode}.`
        : "Randomly generated battle (deterministic generator) played with auto-play.",
      formula: formula({ ...(index % 3 === 1 ? { accuracy: { baseHitChance: 1 } } : {}), ...(mode ? { turnOrder: { mode } } : {}) }),
      players,
      enemies: firstWave,
      waves: rest,
      metadata: { turnLimit: 120 },
      seed: index % 2 === 0 ? 1000 + index : `seed-${index}`,
    }));
  }
  return out;
}

export function buildParityScenarios(generatedCount = 16, generatedPerRoundMode = 4): ParityScenario[] {
  return [
    ...handcrafted(),
    ...generated(generatedCount),
    ...ROUND_MODES.flatMap((mode) => generated(generatedPerRoundMode, mode)),
  ];
}
