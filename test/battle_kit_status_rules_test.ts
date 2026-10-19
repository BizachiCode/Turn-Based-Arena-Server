import assert from "node:assert/strict";

import {
  applyStatus,
  buildStatusSummary,
  createBattleStatusState,
  decideAiCommand,
  hasStatus,
  listUsableSkills,
  stripBuffs,
  type BattleActiveStatus,
  type BattleState,
} from "../src/modules/battle-core";
import {
  ScriptedRandom,
  buildBattleState,
  createTestEngine,
  eventsOfType,
  makeEffect,
  makeFormulas,
  makeSkill,
  startTurnOf,
  statusEffect,
} from "./helpers/battle-test-kit";

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
    ...overrides,
  };
}

const strike = () => makeSkill("strike", [makeEffect()]);

function duel(extra: { a?: any; b?: any; e?: any } = {}): BattleState {
  return buildBattleState([
    { id: "A", side: "players", skills: [strike()], turnBar: 1000, ...(extra.a ?? {}) },
    { id: "B", side: "players", skills: [strike()], ...(extra.b ?? {}) },
    { id: "E", side: "enemies", skills: [strike()], ...(extra.e ?? {}) },
  ]);
}

describe("Status timing", () => {
  it("applies continuous damage at turn start; a lethal tick ends the turn and fires OnDeath passives", () => {
    const state = duel({
      a: {
        passives: [{
          id: "rebirth",
          triggers: [{ trigger: "OnDeath", chance: 1, target: "Self", effects: [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })] }],
        }],
      },
    });
    state.units.A.currentHp = 30;
    state.units.A.statuses.push(status({ status: "ContinuousDamage", isBuff: false, percentPerTurn: 0.05, sourceId: "E" }));

    const engine = createTestEngine();
    const result = startTurnOf(engine, state, "A");
    const types = result.events.map((event) => event.type);

    assert.equal(eventsOfType(result.events, "periodic_damage")[0].amount, 50);
    const died = eventsOfType(result.events, "unit_died")[0];
    assert.equal(died.targetId, "A");
    assert.equal(died.cause, "continuous_damage");
    assert.ok(types.indexOf("unit_died") < types.indexOf("passive_triggered"));
    assert.equal(eventsOfType(result.events, "turn_skipped")[0].reason, "died");
    assert.equal(eventsOfType(result.events, "turn_ended")[0].reason, "died");
    assert.equal(result.state.units.A.currentHp, 500);
    assert.equal(result.state.units.A.statuses.length, 0);
    assert.equal(result.state.phase, "waiting_for_turn");
  });

  it("heals HP regeneration at turn start (default 15% of max HP)", () => {
    const state = duel();
    state.units.A.currentHp = 500;
    state.units.A.statuses.push(status({ status: "HpRegen" }));

    const result = startTurnOf(createTestEngine(), state, "A");
    assert.equal(eventsOfType(result.events, "periodic_heal")[0].amount, 150);
    assert.equal(result.state.units.A.currentHp, 650);
  });

  it("does not tick statuses a unit applied to itself during its own turn", () => {
    const buffStrike = makeSkill("buff_strike", [makeEffect(), statusEffect("AttackUp", 1, { target: "Self" })]);
    const state = duel({ a: { skills: [buffStrike] } });
    const engine = createTestEngine();

    const turn = startTurnOf(engine, state, "A");
    const used = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "buff_strike", targetId: "E" });
    const buff = used.state.units.A.statuses.find((entry) => entry.status === "AttackUp");
    assert.equal(buff?.remainingTurns, 1);

    used.state.units.A.turnBar = 1000;
    const second = engine.dispatch(used.state, { type: "start_turn", actorId: "A" });
    assert.equal(hasStatus(second.state.units.A, "AttackUp"), true);
    const ended = engine.dispatch(second.state, { type: "end_turn", actorId: "A" });
    assert.equal(hasStatus(ended.state.units.A, "AttackUp"), false);
    assert.equal(eventsOfType(ended.events, "status_tick")[0].remainingTurns, 0);
    assert.equal(eventsOfType(ended.events, "status_removed")[0].reason, "expired");
  });

  it("hard crowd control skips the turn and still ticks down", () => {
    const state = duel();
    state.units.A.statuses.push(status({ status: "Freeze", isBuff: false, remainingTurns: 2, sourceId: "E" }));

    const result = startTurnOf(createTestEngine(), state, "A");
    assert.equal(eventsOfType(result.events, "turn_skipped")[0].reason, "control");
    assert.equal(result.state.units.A.statuses[0].remainingTurns, 1);
    assert.equal(result.state.units.A.turnBar, 0);
  });

  it("a 1-turn stun inflicted by a counterattack during the attacker's turn wears off at the end of that turn", () => {
    const stunCounter = makeSkill("stun_counter", [makeEffect(), statusEffect("Stun", 1)]);
    const state = duel({ e: { skills: [stunCounter] } });
    state.units.E.statuses.push(status({ status: "Counterattack", sourceId: "E" }));
    const engine = createTestEngine();

    const turn = startTurnOf(engine, state, "A");
    const used = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });
    assert.equal(eventsOfType(used.events, "counterattack_triggered").length, 1);
    assert.equal(eventsOfType(used.events, "status_applied").some((event) => event.targetId === "A" && event.status === "Stun"), true);
    assert.equal(hasStatus(used.state.units.A, "Stun"), false);
  });
});

describe("Control statuses", () => {
  it("provoke forces skill 1 on the provoker for commands and AI", () => {
    const big = makeSkill("big", [makeEffect({ damageTerms: [{ source: "Attack", multiplier: 3 }] })], { cooldownByLevel: [3] });
    const state = duel({ e: { skills: [strike(), big], turnBar: 1000 }, a: { turnBar: 0 } });
    state.units.E.statuses.push(status({ status: "Provoke", isBuff: false, sourceId: "B" }));
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "E");

    assert.equal(engine.dispatch(turn.state, { type: "use_skill", actorId: "E", skillId: "big", targetId: "B" }).error, "PROVOKED");
    assert.equal(engine.dispatch(turn.state, { type: "use_skill", actorId: "E", skillId: "strike", targetId: "A" }).error, "PROVOKED");
    assert.equal(engine.dispatch(turn.state, { type: "use_skill", actorId: "E", skillId: "strike", targetId: "B" }).accepted, true);

    const decision = decideAiCommand(turn.state, "E", makeFormulas());
    assert.equal(decision.kind, "provoked");
    assert.deepEqual(decision.command, { type: "use_skill", actorId: "E", skillId: "strike", targetId: "B" });

    turn.state.units.B.currentHp = 0;
    assert.equal(engine.dispatch(turn.state, { type: "use_skill", actorId: "E", skillId: "big", targetId: "A" }).accepted, true);
  });

  it("silence only allows skills without cooldown", () => {
    const big = makeSkill("big", [makeEffect()], { cooldownByLevel: [3] });
    const state = duel({ a: { skills: [strike(), big] } });
    state.units.A.statuses.push(status({ status: "Silence", isBuff: false, sourceId: "E" }));
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");

    assert.deepEqual(listUsableSkills(turn.state, turn.state.units.A).map((skill) => skill.id), ["strike"]);
    assert.equal(engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "big", targetId: "E" }).error, "SILENCED");
    assert.equal(engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" }).accepted, true);
  });

  it("oblivion disables passive triggers and passive-granted self statuses", () => {
    const passive = {
      id: "focus",
      triggers: [{ trigger: "OnTurnStart" as const, chance: 1, target: "Self" as const, effects: [statusEffect("AttackUp", 1)] }],
    };
    const state = duel({ a: { passives: [passive] } });
    state.units.A.statuses.push(status({ status: "Oblivion", isBuff: false, sourceId: "E" }));
    state.units.A.statuses.push(status({ status: "Endure", remainingTurns: 99, sourceId: "A", passiveId: "focus" }));

    assert.equal(buildStatusSummary(state.units.A).hasEndure, false);
    const result = startTurnOf(createTestEngine(), state, "A");
    assert.equal(eventsOfType(result.events, "passive_triggered").length, 0);
    assert.equal(hasStatus(result.state.units.A, "AttackUp"), false);
  });
});

describe("Defensive statuses", () => {
  function hitTwice(endureMagnitude: number) {
    const multi = makeSkill("multi", [makeEffect({ damageTerms: [{ source: "Attack", multiplier: 8 }], hits: 2 })]);
    const state = duel({ a: { skills: [multi] } });
    state.units.E.currentHp = 100;
    state.units.E.statuses.push(status({ status: "Endure", magnitude: endureMagnitude, value: endureMagnitude > 0 ? endureMagnitude : null }));
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");
    return engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "multi", targetId: "E" });
  }

  it("endure prevents death for its whole duration without being consumed", () => {
    const result = hitTwice(0);
    const hits = eventsOfType(result.events, "damage_applied");
    assert.deepEqual(hits.map((hit) => [hit.amount, hit.endured, hit.hitIndex, hit.hitCount]), [[99, true, 0, 2], [0, true, 1, 2]]);
    assert.equal(result.state.units.E.currentHp, 1);
    assert.equal(hasStatus(result.state.units.E, "Endure"), true);
  });

  it("endure with a magnitude is a number of charges", () => {
    const result = hitTwice(1);
    assert.equal(result.state.units.E.currentHp, 0);
    assert.equal(eventsOfType(result.events, "status_removed")[0].reason, "consumed");
  });

  it("shield is a status whose absorb value is tracked, consumed, stripped and removed on expiry", () => {
    const caster = createBattleStatusState({ unitId: "caster", stats: { atk: 100, def: 100, spd: 100, cr: 0, cd: 1.5, res: 0, acc: 0, eva: 0 }, maxHp: 2000 });
    const target = createBattleStatusState({ unitId: "target", stats: { atk: 100, def: 100, spd: 100, cr: 0, cd: 1.5, res: 0, acc: 0, eva: 0 }, maxHp: 1000, shield: 40 });

    const applied = applyStatus({ source: caster, target, status: "Shield", duration: 2 });
    assert.equal(applied.ok, true);
    assert.equal(target.shield, 340);
    assert.equal(target.statuses[0].value, 300);

    const flat = applyStatus({ source: caster, target, status: "Shield", duration: 3, magnitude: 500 });
    assert.equal(flat.ok, true);
    assert.equal(target.statuses.length, 1);
    assert.equal(target.statuses[0].value, 500);
    assert.equal(target.shield, 540);

    const stripped = stripBuffs(target, 1, () => 0);
    assert.equal(stripped.ok, true);
    assert.equal(target.shield, 40);
    assert.deepEqual(eventsOfType(stripped.events, "shield_changed").map((event) => event.amount), [-500]);
  });

  it("shield absorbs hits first and the remaining value disappears when it expires", () => {
    const shieldSkill = makeSkill("shield", [statusEffect("Shield", 1)], { targetSide: "Ally" });
    const state = duel({ a: { skills: [shieldSkill] } });
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");
    const shielded = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "shield", targetId: "B" });
    assert.equal(shielded.state.units.B.shield, 150);

    shielded.state.units.E.turnBar = 1000;
    const enemyTurn = engine.dispatch(shielded.state, { type: "start_turn", actorId: "E" });
    const hit = engine.dispatch(enemyTurn.state, { type: "use_skill", actorId: "E", skillId: "strike", targetId: "B" });
    const damage = eventsOfType(hit.events, "damage_applied")[0];
    assert.equal(damage.amount, 0);
    assert.equal(damage.absorbed, 50);
    assert.equal(hit.state.units.B.currentHp, 1000);
    assert.equal(hit.state.units.B.shield, 100);

    hit.state.units.B.turnBar = 1000;
    const bTurn = engine.dispatch(hit.state, { type: "start_turn", actorId: "B" });
    const bEnd = engine.dispatch(bTurn.state, { type: "end_turn", actorId: "B" });
    assert.equal(bEnd.state.units.B.shield, 0);
    assert.equal(eventsOfType(bEnd.events, "shield_changed")[0].amount, -100);
  });

  it("reflect damage returns a fraction of the HP damage to the attacker", () => {
    const state = duel();
    state.units.E.statuses.push(status({ status: "ReflectDamage" }));
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });
    const reflect = eventsOfType(result.events, "damage_applied").find((event) => event.kind === "reflect");
    assert.equal(reflect.targetId, "A");
    assert.equal(reflect.sourceId, "E");
    assert.equal(reflect.amount, 15);
  });

  it("counterattack buff counters with skill 1 and counters never chain", () => {
    const state = duel();
    state.units.A.statuses.push(status({ status: "Counterattack" }));
    state.units.E.statuses.push(status({ status: "Counterattack" }));
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });

    const counters = eventsOfType(result.events, "counterattack_triggered");
    assert.equal(counters.length, 1);
    assert.equal(counters[0].actorId, "E");
    const counterSkill = eventsOfType(result.events, "skill_used").find((event) => event.trigger === "counterattack");
    assert.equal(counterSkill.skillId, "strike");
    assert.equal(result.state.units.A.currentHp, 950);
  });

  it("invincibility blocks hits, immunity blocks debuffs and ATB reduction, beneficial block blocks buffs, heal block blocks heals", () => {
    const debuffAll = makeSkill("debuff", [
      makeEffect(),
      statusEffect("AttackBreak", 2),
      makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.5 }),
    ]);
    const state = duel({ a: { skills: [debuffAll] } });
    state.units.E.statuses.push(status({ status: "Immunity" }));
    state.units.E.turnBar = 600;
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "debuff", targetId: "E" });
    assert.equal(eventsOfType(result.events, "status_blocked")[0].reason, "IMMUNITY");
    assert.equal(eventsOfType(result.events, "effect_resisted")[0].reason, "IMMUNITY");
    assert.equal(result.state.units.E.turnBar, 600);

    const invincible = duel();
    invincible.units.E.statuses.push(status({ status: "Invincibility" }));
    const t2 = startTurnOf(engine, invincible, "A");
    const r2 = engine.dispatch(t2.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });
    assert.equal(eventsOfType(r2.events, "attack_missed")[0].reason, "invulnerable");
    assert.equal(r2.state.units.E.currentHp, 1000);

    const buffSkill = makeSkill("buff", [statusEffect("AttackUp", 2), makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1 })], { targetSide: "Ally" });
    const blocked = duel({ a: { skills: [buffSkill] } });
    blocked.units.B.statuses.push(status({ status: "BeneficialBlock", isBuff: false }));
    blocked.units.B.statuses.push(status({ status: "Unrecoverable", isBuff: false }));
    blocked.units.B.currentHp = 500;
    const t3 = startTurnOf(engine, blocked, "A");
    const r3 = engine.dispatch(t3.state, { type: "use_skill", actorId: "A", skillId: "buff", targetId: "B" });
    assert.equal(eventsOfType(r3.events, "status_blocked")[0].reason, "BENEFICIAL_BLOCK");
    assert.equal(eventsOfType(r3.events, "heal_blocked").length, 1);
    assert.equal(r3.state.units.B.currentHp, 500);
  });

  it("bombs stack as instances, detonate at the end of the bearer's turn and stun unless immune", () => {
    const bombSkill = makeSkill("bomb", [statusEffect("Bomb", 1)]);
    const state = duel({ a: { skills: [bombSkill] } });
    const engine = createTestEngine();
    let current = startTurnOf(engine, state, "A").state;
    current = engine.dispatch(current, { type: "use_skill", actorId: "A", skillId: "bomb", targetId: "E" }).state;
    current.units.A.turnBar = 1000;
    current = engine.dispatch(current, { type: "start_turn", actorId: "A" }).state;
    const second = engine.dispatch(current, { type: "use_skill", actorId: "A", skillId: "bomb", targetId: "E" });
    const bombs = second.state.units.E.statuses.filter((entry) => entry.status === "Bomb");
    assert.equal(bombs.length, 2);
    assert.equal(bombs[0].value, 75);
    assert.equal(eventsOfType(second.events, "status_applied")[0].stacks, 2);

    second.state.units.E.turnBar = 1000;
    const eTurn = engine.dispatch(second.state, { type: "start_turn", actorId: "E" });
    const eEnd = engine.dispatch(eTurn.state, { type: "end_turn", actorId: "E" });
    const blasts = eventsOfType(eEnd.events, "damage_applied").filter((event) => event.kind === "bomb");
    assert.deepEqual(blasts.map((event) => event.amount), [75, 75]);
    assert.equal(eventsOfType(eEnd.events, "status_removed").filter((event) => event.reason === "detonated").length, 2);
    assert.equal(eEnd.state.units.E.currentHp, 850);
    const stun = eEnd.state.units.E.statuses.find((entry) => entry.status === "Stun");
    assert.equal(stun?.remainingTurns, 1);
    assert.equal(stun?.sourceId, "A");

    const immune = createBattleStatusState({ unitId: "immune", stats: { atk: 0, def: 0, spd: 100, cr: 0, cd: 1.5, res: 0, acc: 0, eva: 0 }, maxHp: 1000 });
    immune.statuses.push(status({ status: "Immunity", remainingTurns: 5 }));
    immune.statuses.push(status({ status: "Bomb", isBuff: false, remainingTurns: 1, value: 10, sourceId: "A" }));
    const { tickStatusesEndOfTurn } = require("../src/modules/battle-core");
    const tick = tickStatusesEndOfTurn(immune);
    assert.equal(immune.currentHp, 990);
    assert.equal(eventsOfType(tick.events, "status_blocked")[0].reason, "IMMUNITY");
  });

  it("continuous damage stacks as independent instances up to 10", () => {
    const target = createBattleStatusState({ unitId: "t", stats: { atk: 0, def: 0, spd: 100, cr: 0, cd: 1.5, res: 0, acc: 0, eva: 0 }, maxHp: 1000 });
    for (let i = 0; i < 11; i++) applyStatus({ target, status: "ContinuousDamage", duration: 1 + (i % 3), skipResistance: true });
    assert.equal(target.statuses.length, 10);
    assert.equal(target.statuses[0].percentPerTurn, 0.05);
    const blocked = applyStatus({ target, status: "ContinuousDamage", duration: 2, skipResistance: true });
    assert.equal(blocked.reason, "MAX_STACKS");
  });
});

describe("Stat modifiers and defaults", () => {
  function damageWith(statuses: { a?: BattleActiveStatus[]; e?: BattleActiveStatus[] }, formulas = makeFormulas(), aExtra: any = {}) {
    const state = duel({ a: aExtra });
    for (const entry of statuses.a ?? []) state.units.A.statuses.push(entry);
    for (const entry of statuses.e ?? []) state.units.E.statuses.push(entry);
    const engine = createTestEngine({ formulas });
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });
    return eventsOfType(result.events, "damage_applied")[0];
  }

  it("stat buffs and debuffs add percentages of the base stat", () => {
    assert.equal(damageWith({}).amount, 50);
    assert.equal(damageWith({ a: [status({ status: "AttackUp" })] }).amount, 75);
    assert.equal(damageWith({ a: [status({ status: "AttackUp" }), status({ status: "AttackBreak", isBuff: false })] }).amount, 50);
    assert.equal(damageWith({ e: [status({ status: "DefenseBreak", isBuff: false })] }).amount, 77);
    assert.equal(damageWith({ e: [status({ status: "Brand", isBuff: false })] }).amount, 63);

    const state = duel();
    state.units.A.baseStats = { ...state.units.A.stats, atk: 60 };
    state.units.A.statuses.push(status({ status: "AttackUp" }));
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });
    assert.equal(eventsOfType(result.events, "damage_applied")[0].amount, 65);
  });

  it("uses configurable status defaults when the authored magnitude is 0", () => {
    const formulas = makeFormulas({ statusDefaults: { AttackUp: { magnitude: 0.2 } } });
    const buffStrike = makeSkill("buff", [statusEffect("AttackUp", 2)], { targetSide: "Ally" });
    const state = duel({ a: { skills: [buffStrike] } });
    const engine = createTestEngine({ formulas });
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "buff", targetId: "B" });
    assert.equal(result.state.units.B.statuses[0].magnitude, 0.2);
  });

  it("glancing debuff adds 50% glancing chance and glancing hits deal 70%", () => {
    const state = duel();
    state.units.A.statuses.push(status({ status: "Glancing", isBuff: false }));
    const engine = createTestEngine({ rng: new ScriptedRandom([0.4]) });
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });
    const hit = eventsOfType(result.events, "damage_applied")[0];
    assert.equal(hit.isGlancing, true);
    assert.equal(hit.amount, 35);
  });
});
