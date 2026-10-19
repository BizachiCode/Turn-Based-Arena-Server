import assert from "node:assert/strict";

import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";
import {
  BattleEngine,
  decideAiCommand,
  getEffectiveBattleSpeed,
  hasStatus,
  leaderSkillAppliesToMode,
  resolveEffectiveSkillIds,
  resolveEffectivePassiveIds,
  type BattleActiveStatus,
  type BattleState,
  type CharacterPassiveDTO,
  type SkillEffectDTO,
} from "../src/modules/battle-core";
import {
  buildBattleState,
  createTestEngine,
  eventsOfType,
  makeEffect,
  makeFormulas,
  makeSkill,
  startTurnOf,
  statusEffect,
  type TestUnitSpec,
} from "./helpers/battle-test-kit";

const strike = () => makeSkill("strike", [makeEffect()]);

type UnitKey = "A" | "B" | "E1" | "E2";

/** A (acting, ready) and B on the players' side, E1 / E2 on the enemies' side; 1000 HP, 100 ATK / DEF / SPD. */
function arena(specs: Partial<Record<UnitKey, Partial<TestUnitSpec>>> = {}): BattleState {
  return buildBattleState([
    { id: "A", side: "players", skills: [strike()], turnBar: 1000, ...(specs.A ?? {}) },
    { id: "B", side: "players", skills: [strike()], ...(specs.B ?? {}) },
    { id: "E1", side: "enemies", skills: [strike()], ...(specs.E1 ?? {}) },
    { id: "E2", side: "enemies", skills: [strike()], ...(specs.E2 ?? {}) },
  ]);
}

function status(overrides: Partial<BattleActiveStatus>): BattleActiveStatus {
  return {
    status: "AttackUp", remainingTurns: 2, magnitude: 0, percentPerTurn: 0, isBuff: true, isDispellable: true,
    stacks: 1, maxStacks: 1, uniqueTag: null, sourceId: null, value: null, skipNextTick: false, passiveId: null,
    ...overrides,
  };
}

function cast(state: BattleState, effects: SkillEffectDTO[], targetId = "E1", engine: BattleEngine = createTestEngine(), extra: Record<string, unknown> = {}) {
  state.units.A.skills = [makeSkill("kit", effects, extra)];
  const turn = startTurnOf(engine, state, "A");
  return engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "kit", targetId });
}

const dmg = (extra: Partial<SkillEffectDTO> = {}) => makeEffect({ ...extra });
const hits = (events: any[], targetId = "E1") => eventsOfType(events, "damage_applied").filter((event) => event.targetId === targetId && event.kind === "attack");

describe("Kit mechanics: damage modifiers", () => {
  it("reads the target's max HP and speed in damage terms", () => {
    const result = cast(arena({ E1: { stats: { hp: 2000, spd: 300 } } }), [
      dmg({ damageTerms: [{ source: "TargetMaxHP", multiplier: 0.1 }] }),
      dmg({ damageTerms: [{ source: "TargetSpeed", multiplier: 1 }] }),
    ]);
    assert.deepEqual(hits(result.events).map((event) => event.amount), [100, 150]);
  });

  it("scales damage with HP ratios, status counts and speed", () => {
    const amountOf = (effect: Partial<SkillEffectDTO>, mutate: (state: BattleState) => void = () => {}) => {
      const state = arena();
      mutate(state);
      return hits(cast(state, [dmg(effect)]).events)[0].amount;
    };
    const lowTarget = (state: BattleState) => { state.units.E1.currentHp = 250; };
    assert.equal(amountOf({ scaling: "TargetHpLow", scalingAmount: 1 }, lowTarget), 88, "50 x 1.75");
    assert.equal(amountOf({ scaling: "TargetHpHigh", scalingAmount: 1 }, lowTarget), 63, "50 x 1.25");
    assert.equal(amountOf({ scaling: "CasterHpLow", scalingAmount: 1 }, (state) => { state.units.A.currentHp = 500; }), 75);
    assert.equal(amountOf({ scaling: "CasterHpHigh", scalingAmount: 1 }), 100);
    assert.equal(amountOf({ scaling: "TargetDebuffCount", scalingAmount: 0.5 }, (state) => {
      state.units.E1.statuses.push(status({ status: "Slow", isBuff: false }), status({ status: "Silence", isBuff: false }));
    }), 100);
    assert.equal(amountOf({ scaling: "CasterBuffCount", scalingAmount: 1 }, (state) => {
      state.units.A.statuses.push(status({ status: "Immunity" }));
    }), 100);
    assert.equal(amountOf({ scaling: "CasterSpeed", scalingAmount: 1 }), 100);
  });

  it("ignores defense, guarantees crits with a bonus multiplier and blocks glancing", () => {
    assert.equal(hits(cast(arena(), [dmg({ ignoreDefense: 1 })]).events)[0].amount, 100);
    assert.equal(hits(cast(arena(), [dmg({ ignoreDefense: 0.5 })]).events)[0].amount, 67);

    const crit = hits(cast(arena(), [dmg({ guaranteedCrit: true, critDamageBonus: 0.5 })]).events)[0];
    assert.equal(crit.isCritical, true);
    assert.equal(crit.amount, 100, "50 x (1.5 + 0.5)");

    const glancing = (noGlancing: boolean) => {
      const state = arena();
      state.units.A.statuses.push(status({ status: "Glancing", isBuff: false, magnitude: 1, remainingTurns: 3 }));
      return hits(cast(state, [dmg({ noGlancing })]).events)[0].isGlancing;
    };
    assert.equal(glancing(false), true);
    assert.equal(glancing(true), false);
  });

  it("heals the caster with life steal unless it is heal blocked", () => {
    const state = arena();
    state.units.A.currentHp = 500;
    const result = cast(state, [dmg({ lifeSteal: 0.5 })]);
    const heal = eventsOfType(result.events, "heal_applied")[0];
    assert.equal(heal.kind, "lifesteal");
    assert.equal(heal.amount, 25);
    assert.equal(result.state.units.A.currentHp, 525);

    const blocked = arena();
    blocked.units.A.currentHp = 500;
    blocked.units.A.statuses.push(status({ status: "HealBlock", isBuff: false, remainingTurns: 3 }));
    const blockedResult = cast(blocked, [dmg({ lifeSteal: 0.5 })]);
    assert.equal(eventsOfType(blockedResult.events, "heal_applied").length, 0);
    assert.equal(eventsOfType(blockedResult.events, "heal_blocked").length, 1);
  });

  it("destroys max HP up to 60% of the original max HP over the battle", () => {
    const result = cast(arena(), [dmg({ destroyMaxHp: 0.5 })]);
    const destroyed = eventsOfType(result.events, "max_hp_changed")[0];
    assert.deepEqual([destroyed.kind, destroyed.amount, destroyed.currentMaxHp], ["destroy", -25, 975]);
    assert.equal(result.state.units.E1.metadata.destroyedMaxHp, 25);

    const capped = arena();
    capped.units.E1.maxHp = 410;
    capped.units.E1.currentHp = 410;
    capped.units.E1.metadata.destroyedMaxHp = 590;
    const cappedResult = cast(capped, [dmg({ destroyMaxHp: 0.5 })]);
    assert.equal(cappedResult.state.units.E1.maxHp, 400, "only 10 HP left under the 600 cap");
    assert.equal(cappedResult.state.units.E1.metadata.destroyedMaxHp, 600);
  });
});

describe("Kit mechanics: new effect types", () => {
  it("absorbs the target's attack bar into the caster", () => {
    const state = arena({ E1: { turnBar: 500 } });
    const result = cast(state, [dmg(), makeEffect({ type: "AbsorbTurnBar", damageTerms: [], turnBarAmount: 0.3 })]);
    const absorbed = eventsOfType(result.events, "turn_bar_absorbed")[0];
    assert.deepEqual([absorbed.sourceId, absorbed.targetId, absorbed.amount], ["A", "E1", 300]);
    assert.equal(result.state.units.E1.turnBar, 200);
    assert.equal(result.state.units.A.turnBar, 300);

    const immune = arena({ E1: { turnBar: 500 } });
    immune.units.E1.statuses.push(status({ status: "Immunity" }));
    const blocked = cast(immune, [dmg(), makeEffect({ type: "AbsorbTurnBar", damageTerms: [], turnBarAmount: 0.3 })]);
    assert.equal(eventsOfType(blocked.events, "effect_resisted")[0].reason, "IMMUNITY");
    assert.equal(blocked.state.units.E1.turnBar, 500);
  });

  it("grants an extra turn on kill and does not roll Violent on top of it", () => {
    const extraOnKill = () => makeEffect({ type: "ExtraTurn", damageTerms: [], condition: "OnKill" });
    const killed = cast(arena({ E1: { stats: { hp: 10 } }, A: { metadata: { runeSetEffects: { extraTurnChance: 1 } } } }), [dmg(), extraOnKill()]);
    const granted = eventsOfType(killed.events, "extra_turn_granted");
    assert.equal(granted.length, 1);
    assert.deepEqual([granted[0].source, granted[0].skillId], ["skill", "kit"]);
    assert.equal(killed.state.metadata.extraTurnActorId, "A");
    assert.equal(killed.state.units.A.turnBar, 1000);
    assert.equal(killed.state.metadata.pendingExtraTurn, undefined);

    const survived = cast(arena(), [dmg(), extraOnKill()]);
    assert.equal(eventsOfType(survived.events, "extra_turn_granted").length, 0);
  });

  it("repeats the skill once as an additional attack, on a new enemy when the target died", () => {
    const repeat = () => makeEffect({ type: "AdditionalAttack", damageTerms: [] });
    const result = cast(arena(), [dmg(), repeat()]);
    const used = eventsOfType(result.events, "skill_used");
    assert.deepEqual(used.map((event) => event.trigger), ["turn_action", "additional_attack"]);
    assert.equal(eventsOfType(result.events, "additional_attack_triggered").length, 1);
    assert.equal(hits(result.events).length, 2);

    const killed = cast(arena({ E1: { stats: { hp: 10 } } }), [dmg(), repeat()]);
    const followUp = eventsOfType(killed.events, "additional_attack_triggered")[0];
    assert.equal(followUp.targetId, "E2");
    assert.equal(hits(killed.events, "E2").length, 1);
  });

  it("calls allies to attack the target with their first skill", () => {
    const result = cast(arena(), [dmg(), makeEffect({ type: "AllyAttack", damageTerms: [], buffCount: 1 })]);
    const call = eventsOfType(result.events, "ally_attack_triggered")[0];
    assert.deepEqual([call.actorId, call.sourceId, call.targetId, call.skillId], ["B", "A", "E1", "strike"]);
    const used = eventsOfType(result.events, "skill_used");
    assert.deepEqual(used.map((event) => [event.actorId, event.trigger]), [["A", "turn_action"], ["B", "ally_attack"]]);
    assert.equal(result.state.units.B.cooldowns.strike ?? 0, 0);

    const stunned = arena();
    stunned.units.B.statuses.push(status({ status: "Stun", isBuff: false }));
    assert.equal(eventsOfType(cast(stunned, [dmg(), makeEffect({ type: "AllyAttack", damageTerms: [] })]).events, "ally_attack_triggered").length, 0);
  });

  it("transfers the caster's harmful effects to the target", () => {
    const state = arena();
    state.units.A.statuses.push(
      status({ status: "DefenseBreak", isBuff: false, remainingTurns: 3, sourceId: "E2" }),
      status({ status: "Slow", isBuff: false, remainingTurns: 2, sourceId: "E2" }),
    );
    const result = cast(state, [dmg(), makeEffect({ type: "TransferDebuffs", damageTerms: [], buffCount: 0 })]);
    assert.equal(result.state.units.A.statuses.filter((active) => !active.isBuff).length, 0);
    const moved = result.state.units.E1.statuses.filter((active) => !active.isBuff);
    assert.deepEqual(moved.map((active) => [active.status, active.remainingTurns, active.sourceId]).sort(), [["DefenseBreak", 3, "A"], ["Slow", 2, "A"]]);
    assert.equal(eventsOfType(result.events, "status_removed").filter((event) => event.reason === "transfer").length, 2);
  });

  it("changes the cooldown of BuffCount skills (0 = every skill)", () => {
    const skills = [strike(), makeSkill("s2", [makeEffect()], { cooldownByLevel: [3] }), makeSkill("s3", [makeEffect()], { cooldownByLevel: [4] })];
    const raise = (buffCount: number) => cast(arena({ E1: { skills } }), [dmg(), makeEffect({ type: "CooldownChange", damageTerms: [], cooldownTurns: 2, buffCount })]).state.units.E1.cooldowns;
    assert.deepEqual(raise(0), { s2: 2, s3: 2 });
    assert.equal(Object.values(raise(1)).filter((turns) => turns > 0).length, 1);

    const reset = arena({ B: { skills } });
    reset.units.B.cooldowns = { s2: 3, s3: 4 };
    const result = cast(reset, [makeEffect({ type: "CooldownChange", damageTerms: [], cooldownIncrease: false, cooldownTurns: 5, buffCount: 0 })], "B", createTestEngine(), { targetSide: "Ally" });
    assert.deepEqual(result.state.units.B.cooldowns, { s2: 0, s3: 0 });
    assert.equal(eventsOfType(result.events, "cooldown_changed").filter((event) => event.targetId === "B").length, 2);
  });

  it("changes the duration of buffs or debuffs", () => {
    const shorten = (turns: number) => {
      const state = arena();
      state.units.E1.statuses.push(status({ status: "AttackUp", remainingTurns: 2 }));
      return cast(state, [dmg(), makeEffect({ type: "ChangeStatusDuration", damageTerms: [], isBuff: true, cooldownIncrease: false, cooldownTurns: turns })]);
    };
    const once = shorten(1);
    assert.equal(once.state.units.E1.statuses[0].remainingTurns, 1);
    assert.equal(eventsOfType(once.events, "status_duration_changed")[0].amount, -1);
    const removed = shorten(2);
    assert.equal(hasStatus(removed.state.units.E1, "AttackUp"), false);
    assert.equal(eventsOfType(removed.events, "status_removed")[0].reason, "duration");

    const allies = arena();
    allies.units.B.statuses.push(status({ status: "DefenseUp", remainingTurns: 2 }));
    const extended = cast(allies, [makeEffect({ type: "ChangeStatusDuration", damageTerms: [], isBuff: true, cooldownIncrease: true, cooldownTurns: 1, target: "AllAllies" })], "B");
    assert.equal(extended.state.units.B.statuses[0].remainingTurns, 3);
  });
});

describe("Kit mechanics: conditions, resistance and statuses", () => {
  it("evaluates OnKill, TargetHasDebuff, TargetHasNoBuff, TargetHasNoDebuff and CasterHpBelow", () => {
    const stunIf = (condition: SkillEffectDTO["condition"], conditionValue = 0) => statusEffect("Stun", 1, { condition, conditionValue });
    const stunned = (state: BattleState, effect: SkillEffectDTO) => hasStatus(cast(state, [dmg(), effect]).state.units.E1, "Stun");

    assert.equal(stunned(arena(), stunIf("TargetHasDebuff")), false);
    const debuffed = arena();
    debuffed.units.E1.statuses.push(status({ status: "Slow", isBuff: false, remainingTurns: 3 }));
    assert.equal(stunned(debuffed, stunIf("TargetHasDebuff")), true);
    assert.equal(stunned(arena(), stunIf("TargetHasNoDebuff")), true);
    assert.equal(stunned(arena(), stunIf("TargetHasNoBuff")), true);
    const buffed = arena();
    buffed.units.E1.statuses.push(status({ status: "DefenseUp", remainingTurns: 3 }));
    assert.equal(stunned(buffed, stunIf("TargetHasNoBuff")), false);
    assert.equal(stunned(arena(), stunIf("CasterHpBelow", 0.5)), false);
    const hurt = arena();
    hurt.units.A.currentHp = 400;
    assert.equal(stunned(hurt, stunIf("CasterHpBelow", 0.5)), true);

    const heal = makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1, target: "Self", condition: "OnKill" });
    const killer = arena({ E1: { stats: { hp: 10 } } });
    killer.units.A.currentHp = 500;
    assert.equal(cast(killer, [dmg(), heal]).state.units.A.currentHp, 600);
  });

  it("evaluates CasterHasStatus, TargetHasStatus, TargetIsNotBoss and CasterStatHigher", () => {
    const stunIf = (extra: Partial<SkillEffectDTO>) => statusEffect("Stun", 1, extra);
    const stunned = (state: BattleState, effect: SkillEffectDTO) => hasStatus(cast(state, [dmg(), effect]).state.units.E1, "Stun");

    const focused = arena();
    focused.units.A.statuses.push(status({ status: "CritRateUp", remainingTurns: 3 }));
    assert.equal(stunned(focused, stunIf({ condition: "CasterHasStatus", conditionStatus: "CritRateUp" })), true);
    assert.equal(stunned(arena(), stunIf({ condition: "CasterHasStatus", conditionStatus: "CritRateUp" })), false);
    const marked = arena();
    marked.units.E1.statuses.push(status({ status: "Brand", isBuff: false, remainingTurns: 3 }));
    assert.equal(stunned(marked, stunIf({ condition: "TargetHasStatus", conditionStatus: "Brand" })), true);
    assert.equal(stunned(arena(), stunIf({ condition: "TargetHasStatus", conditionStatus: "Brand" })), false);

    const boss = arena();
    boss.units.E1.isBoss = true;
    assert.equal(stunned(boss, stunIf({ condition: "TargetIsNotBoss" })), false);
    assert.equal(stunned(arena(), stunIf({ condition: "TargetIsNotBoss" })), true);

    assert.equal(stunned(arena({ A: { stats: { spd: 150 } } }), stunIf({ condition: "CasterStatHigher", conditionStat: "Speed", conditionValue: 1.4 })), true);
    assert.equal(stunned(arena({ A: { stats: { spd: 130 } } }), stunIf({ condition: "CasterStatHigher", conditionStat: "Speed", conditionValue: 1.4 })), false);
    const ratio = arena();
    ratio.units.E1.currentHp = 400;
    assert.equal(stunned(ratio, stunIf({ condition: "CasterStatHigher", conditionStat: "HpRatio", conditionValue: 1 })), true);
  });

  it("applies Berserk (AttackUp + SpeedUp defaults) and InabilityImmunity", () => {
    const result = cast(arena(), [statusEffect("Berserk", 2, { target: "Self" })], "A", createTestEngine(), { targetSide: "Self" });
    const berserk = result.state.units.A.statuses.find((active) => active.status === "Berserk")!;
    assert.deepEqual([berserk.magnitude, berserk.value], [0.5, 0.3]);
    const raging = arena();
    raging.units.A.statuses.push(status({ status: "Berserk", magnitude: 0.5, value: 0.3 }));
    assert.equal(hits(cast(raging, [dmg()]).events)[0].amount, 75, "ATK +50%");
    assert.equal(getEffectiveBattleSpeed(raging.units.A), 130, "SPD +30%");

    const guarded = arena();
    guarded.units.E1.statuses.push(status({ status: "InabilityImmunity" }));
    const blocked = cast(guarded, [dmg(), statusEffect("Stun", 1), statusEffect("Slow", 2)]);
    assert.equal(hasStatus(blocked.state.units.E1, "Stun"), false);
    assert.equal(hasStatus(blocked.state.units.E1, "Slow"), true);
    assert.equal(eventsOfType(blocked.events, "status_blocked")[0].reason, "IMMUNITY");
  });

  it("skips the resistance roll for irresistible effects but still respects Immunity", () => {
    const resistant = () => arena({ E1: { stats: { res: 1 } } });
    assert.equal(hasStatus(cast(resistant(), [dmg(), statusEffect("Stun", 1)]).state.units.E1, "Stun"), false);
    assert.equal(hasStatus(cast(resistant(), [dmg(), statusEffect("Stun", 1, { irresistible: true })]).state.units.E1, "Stun"), true);
    const immune = resistant();
    immune.units.E1.statuses.push(status({ status: "Immunity" }));
    assert.equal(hasStatus(cast(immune, [dmg(), statusEffect("Stun", 1, { irresistible: true })]).state.units.E1, "Stun"), false);
  });

  it("applies DamageReduction and CritResistUp", () => {
    const reduced = arena();
    reduced.units.E1.statuses.push(status({ status: "DamageReduction" }));
    assert.equal(hits(cast(reduced, [dmg()]).events)[0].amount, 35);

    const resisting = arena({ A: { stats: { cr: 0.5 } } });
    resisting.units.E1.statuses.push(status({ status: "CritResistUp" }));
    const result = cast(resisting, [dmg({ hits: 6 })]);
    assert.equal(hits(result.events).every((event) => !event.isCritical), true);
  });

  it("forces single-target enemy skills onto Threat bearers", () => {
    const state = arena();
    state.units.E2.statuses.push(status({ status: "Threat" }));
    assert.equal(cast(state, [dmg()], "E1").error, "INVALID_TARGET_THREAT");
    assert.equal(cast(state, [dmg()], "E2").accepted, true);
    assert.equal(cast(state, [dmg()], "E1", createTestEngine(), { targeting: "AllEnemies" }).accepted, true);
    state.units.A.skills = [strike()];
    const ai = decideAiCommand(startTurnOf(createTestEngine(), state, "A").state, "A", makeFormulas());
    assert.equal((ai.command as any).targetId, "E2");
  });

  it("keeps Unrevivable through death and blocks revive passives", () => {
    const phoenix: CharacterPassiveDTO = {
      id: "phoenix",
      triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })] }],
    };
    const state = arena({ E1: { stats: { hp: 10 }, passives: [phoenix] } });
    state.units.E1.statuses.push(status({ status: "Unrevivable", isBuff: false, remainingTurns: 2 }));
    const result = cast(state, [dmg()]);
    assert.equal(result.state.units.E1.currentHp, 0);
    assert.equal(eventsOfType(result.events, "revive_blocked")[0].reason, "UNREVIVABLE");
    assert.equal(hasStatus(result.state.units.E1, "Unrevivable"), true);
  });

  it("blocks attack bar increases from effects on frozen units", () => {
    const state = arena();
    state.units.B.statuses.push(status({ status: "Freeze", isBuff: false }));
    const push = makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 0.5 });
    assert.equal(cast(state, [push], "B").state.units.B.turnBar, 0);
    state.units.B.statuses = [];
    assert.equal(cast(state, [push], "B").state.units.B.turnBar, 500);
  });

  it("stores Unrecoverable as its canonical HealBlock", () => {
    const result = cast(arena(), [dmg(), statusEffect("Unrecoverable", 2)]);
    assert.equal(eventsOfType(result.events, "status_applied")[0].status, "HealBlock");
    assert.equal(hasStatus(result.state.units.E1, "Unrecoverable"), true);
  });
});

describe("Kit mechanics: passives", () => {
  const passive = (id: string, trigger: any, effects: SkillEffectDTO[], target: any = "Self"): CharacterPassiveDTO => ({
    id, triggers: [{ trigger, chance: 1, target, effects }],
  });
  const triggered = (events: any[], trigger: string) => eventsOfType(events, "passive_triggered").filter((event) => event.trigger === trigger);

  it("runs BeforeAttack before the skill's damage", () => {
    const result = cast(arena({ A: { passives: [passive("rage", "BeforeAttack", [statusEffect("AttackUp", 2)])] } }), [dmg()]);
    const before = triggered(result.events, "BeforeAttack");
    assert.equal(before.length, 1);
    assert.ok(result.events.indexOf(before[0]) < result.events.indexOf(hits(result.events)[0]));
    assert.equal(hits(result.events)[0].amount, 75, "the AttackUp from BeforeAttack powers the hit");
  });

  it("raises OnCrit, OnKill, OnAllyDeath, OnDebuffed and OnTurnEnd", () => {
    const state = arena({
      A: { stats: { cr: 1 }, passives: [
        passive("eye", "OnCrit", [statusEffect("CritRateUp", 1)]),
        passive("reaper", "OnKill", [statusEffect("AttackUp", 1)]),
        passive("tail", "OnTurnEnd", [statusEffect("DefenseUp", 1)]),
      ] },
      E1: { stats: { hp: 10 } },
      E2: { passives: [passive("grief", "OnAllyDeath", [statusEffect("AttackUp", 2)])] },
    });
    const result = cast(state, [dmg()]);
    for (const trigger of ["OnCrit", "OnKill", "OnAllyDeath", "OnTurnEnd"]) assert.equal(triggered(result.events, trigger).length, 1, trigger);
    assert.equal(hasStatus(result.state.units.E2, "AttackUp"), true);
    const turnEnded = eventsOfType(result.events, "turn_ended")[0];
    assert.ok(result.events.indexOf(triggered(result.events, "OnTurnEnd")[0]) < result.events.indexOf(turnEnded));

    const debuffed = cast(arena({ E1: { passives: [passive("shake", "OnDebuffed", [makeEffect({ type: "Cleanse", damageTerms: [], buffCount: 0 })])] } }), [dmg(), statusEffect("Slow", 2)]);
    assert.equal(triggered(debuffed.events, "OnDebuffed").length, 1);
    assert.equal(hasStatus(debuffed.state.units.E1, "Slow"), false);
  });

  it("raises OnCritReceived on the unit hit by a crit and OnHealed on healed units", () => {
    const state = arena({
      A: { stats: { cr: 1 } },
      E1: { passives: [passive("payback", "OnCritReceived", [statusEffect("Slow", 2)], "Attacker")] },
      B: { passives: [passive("thanks", "OnHealed", [statusEffect("AttackUp", 1)])] },
    });
    state.units.B.currentHp = 500;
    const result = cast(state, [dmg(), makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1, target: "AllAllies" })]);
    const payback = triggered(result.events, "OnCritReceived")[0];
    assert.deepEqual([payback.ownerId, payback.targetIds], ["E1", ["A"]]);
    assert.equal(hasStatus(result.state.units.A, "Slow"), true);
    assert.equal(triggered(result.events, "OnHealed")[0].ownerId, "B");
  });

  it("limits passive triggers with a cooldown in bearer turns and a max per battle", () => {
    const engine = createTestEngine();
    const guard = (extra: Record<string, unknown>): CharacterPassiveDTO => ({
      id: "guard", triggers: [{ trigger: "OnDamaged", chance: 1, target: "Self", effects: [statusEffect("DefenseUp", 1)], ...extra }],
    });
    const hitAgain = (state: BattleState) => {
      state.units.A.turnBar = 1000;
      const turn = engine.dispatch(state, { type: "start_turn", actorId: "A" });
      return engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "kit", targetId: "E1" });
    };
    const passTurnOfE1 = (state: BattleState) => {
      state.units.E1.turnBar = 1000;
      const turn = engine.dispatch(state, { type: "start_turn", actorId: "E1" });
      return engine.dispatch(turn.state, { type: "end_turn", actorId: "E1" }).state;
    };

    const first = cast(arena({ E1: { passives: [guard({ cooldown: 2 })] } }), [dmg()], "E1", engine);
    const fired = triggered(first.events, "OnDamaged")[0];
    assert.equal(fired.cooldown, 2);
    assert.equal(first.state.units.E1.metadata.passiveCooldowns["guard#0"], 2);
    assert.equal(triggered(hitAgain(first.state).events, "OnDamaged").length, 0, "still on cooldown");
    const oneTurn = passTurnOfE1(first.state);
    assert.equal(oneTurn.units.E1.metadata.passiveCooldowns["guard#0"], 1);
    assert.equal(triggered(hitAgain(oneTurn).events, "OnDamaged").length, 0);
    const twoTurns = passTurnOfE1(oneTurn);
    assert.equal(triggered(hitAgain(twoTurns).events, "OnDamaged").length, 1, "ready after two bearer turns");

    const once = cast(arena({ E1: { passives: [guard({ maxPerBattle: 1 })] } }), [dmg()], "E1", engine);
    assert.equal(triggered(once.events, "OnDamaged")[0].remainingUses, 0);
    assert.equal(once.state.units.E1.metadata.passiveUses["guard#0"], 1);
    assert.equal(triggered(hitAgain(once.state).events, "OnDamaged").length, 0, "used up");

    const sealed = structuredClone(first.state);
    sealed.units.E1.statuses.push(status({ status: "Oblivion", isBuff: false }));
    assert.equal(passTurnOfE1(sealed).units.E1.metadata.passiveCooldowns["guard#0"], 1, "Oblivion keeps the counters ticking");
  });

  it("fires a passive trigger at most once per bearer per action (no death / revive ping-pong)", () => {
    const phoenix: CharacterPassiveDTO = {
      id: "phoenix",
      triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })] }],
    };
    const result = cast(arena({ E1: { passives: [phoenix] } }), [
      dmg({ damageTerms: [], flatDamageBonus: 4000 }),
      makeEffect({ type: "AdditionalAttack", damageTerms: [] }),
    ]);
    assert.equal(triggered(result.events, "OnDeath").length, 1);
    assert.equal(eventsOfType(result.events, "unit_died").filter((event) => event.targetId === "E1").length, 2);
    assert.equal(result.state.units.E1.currentHp, 0, "the second death is final within the same action");
  });

  it("targets the lowest HP ally and a random enemy", () => {
    const state = arena({ A: { passives: [
      passive("mend", "OnAttack", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1 })], "LowestHpAlly"),
      passive("jinx", "OnAttack", [statusEffect("Slow", 2)], "RandomEnemy"),
    ] } });
    state.units.B.currentHp = 300;
    const result = cast(state, [dmg()]);
    const [mend, jinx] = eventsOfType(result.events, "passive_triggered");
    assert.deepEqual(mend.targetIds, ["B"]);
    assert.equal(jinx.targetIds.length, 1);
    assert.equal(result.state.units.B.currentHp, 400);
  });

  it("evaluates auras live: removed on the bearer's death, suppressed by Oblivion", () => {
    const auraPassive = (stat: any, percent: number, extra: Record<string, unknown> = {}): CharacterPassiveDTO => ({
      id: `aura_${stat}`, triggers: [], auras: [{ stat, percent, flat: 0, scope: "AllAllies", activeWhileAlive: true, ...extra }],
    });
    const engine = createTestEngine();
    const state = arena({ B: { passives: [auraPassive("Attack", 0.5), auraPassive("MaxHP", 0.2)] } });
    const started = engine.start(state);
    assert.equal(started.state.units.A.stats.atk, 150);
    assert.deepEqual([started.state.units.A.maxHp, started.state.units.A.currentHp], [1200, 1200]);
    assert.equal(started.state.units.E1.stats.atk, 100, "AllAllies auras stay on the bearer's side");
    assert.equal(eventsOfType(started.events, "max_hp_changed").filter((event) => event.kind === "aura").length, 2);

    const sealed = structuredClone(started.state);
    sealed.units.B.statuses.push(status({ status: "Oblivion", isBuff: false }));
    sealed.units.E1.skills = [makeSkill("hit", [makeEffect({ damageTerms: [], flatDamageBonus: 0 })])];
    sealed.units.A.skills = [makeSkill("noop", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0, target: "Self" })], { targetSide: "Self" })];
    const turn = engine.dispatch(sealed, { type: "start_turn", actorId: "A" });
    const used = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "noop", targetId: "A" });
    assert.equal(used.state.units.A.stats.atk, 100, "Oblivion on the bearer suppresses its aura");

    const dying = structuredClone(started.state);
    dying.units.B.currentHp = 1;
    dying.units.A.skills = [makeSkill("betray", [makeEffect({ damageTerms: [], flatDamageBonus: 500, target: "AllAllies" })], { targetSide: "Self" })];
    const turn2 = engine.dispatch(dying, { type: "start_turn", actorId: "A" });
    const killed = engine.dispatch(turn2.state, { type: "use_skill", actorId: "A", skillId: "betray", targetId: "A" });
    assert.equal(killed.state.units.B.currentHp, 0);
    assert.equal(killed.state.units.A.stats.atk, 100, "the aura ends with its bearer");
    assert.equal(killed.state.units.A.maxHp, 1000);

    const lingering = engine.start(arena({ B: { passives: [auraPassive("Defense", 0.5, { activeWhileAlive: false })] } })).state;
    lingering.units.B.currentHp = 0;
    lingering.units.B.statuses = [];
    lingering.units.A.skills = [makeSkill("noop", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0, target: "Self" })], { targetSide: "Self" })];
    const turn3 = engine.dispatch(lingering, { type: "start_turn", actorId: "A" });
    assert.equal(engine.dispatch(turn3.state, { type: "use_skill", actorId: "A", skillId: "noop", targetId: "A" }).state.units.A.stats.def, 150);
  });
});

describe("Kit mechanics: awakening upgrades, leader content and AI", () => {
  const character = (rewards: Record<string, unknown>): CharacterDTO => ({
    id: "c", naturalStars: 3, baseStats: { hp: 1, atk: 1, def: 1, spd: 1, sh: 0, cr: 0, cd: 1.5, res: 0, acc: 0, eva: 0 },
    starOverrides: [], skillIds: ["s1", "s2", "s3"], passiveIds: ["p1"],
    awakenings: [{ index: 1, minLevel: 1, minStars: 1, costs: [], tuning: {} as any, rewards: rewards as any }],
  });

  it("replaces skills and passives in their slot on awakening, additions last", () => {
    const c = character({ replaceSkills: [{ from: "s2", to: "s2_awakened" }], addSkillIds: ["s4"], replacePassives: [{ from: "p1", to: "p1_awakened" }] });
    assert.deepEqual(resolveEffectiveSkillIds(c, 0), ["s1", "s2", "s3"]);
    assert.deepEqual(resolveEffectiveSkillIds(c, 1), ["s1", "s2_awakened", "s3", "s4"]);
    assert.deepEqual(resolveEffectivePassiveIds(c, 1), ["p1_awakened"]);
  });

  it("limits leader skills to their content modes", () => {
    const dungeonOnly = { id: "l", scope: "AllAllies" as const, modeFilter: ["dungeon" as const] };
    assert.equal(leaderSkillAppliesToMode(dungeonOnly, "dungeon"), true);
    assert.equal(leaderSkillAppliesToMode(dungeonOnly, "story"), false);
    assert.equal(leaderSkillAppliesToMode({ id: "g", scope: "AllAllies" }, "tower"), true);
  });

  it("aims AbsorbTurnBar at full attack bars, finishers at low HP and skips Unrevivable allies", () => {
    const absorb = makeSkill("absorb", [dmg(), makeEffect({ type: "AbsorbTurnBar", damageTerms: [], turnBarAmount: 0.5 })]);
    const state = arena({ A: { skills: [absorb] }, E1: { turnBar: 100 }, E2: { turnBar: 800 } });
    assert.equal((decideAiCommand(state, "A", makeFormulas()).command as any).targetId, "E2");

    const finisher = makeSkill("execute", [dmg({ scaling: "TargetHpLow", scalingAmount: 1 })]);
    const hurt = arena({ A: { skills: [finisher] } });
    hurt.units.E2.currentHp = 200;
    assert.equal((decideAiCommand(hurt, "A", makeFormulas()).command as any).targetId, "E2");

    const revive = makeSkill("rez", [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })], { targetSide: "Ally" });
    const graveyard = arena({ A: { skills: [strike(), revive] } });
    graveyard.units.B.currentHp = 0;
    graveyard.units.B.statuses.push(status({ status: "Unrevivable", isBuff: false }));
    assert.equal(decideAiCommand(graveyard, "A", makeFormulas()).kind, "attack");
  });
});
