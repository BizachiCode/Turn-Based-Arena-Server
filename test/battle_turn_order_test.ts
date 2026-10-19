import assert from "node:assert/strict";

import {
  AttackBarTurnOrder,
  PveBattleSession,
  getTurnOrderSystem,
  normalizeCombatFormulaSnapshot,
  readRoundState,
  type BattleEvent,
  type PveBattleSessionStepResult,
  type ResolvedCombatFormula,
  type TurnOrderMode,
} from "../src/modules/battle-core";
import {
  buildBattleState,
  createTestEngine,
  eventsOfType,
  makeEffect,
  makeFormulas,
  makeSkill,
  statusEffect,
  type TestUnitSpec,
} from "./helpers/battle-test-kit";

/** A skill that hits for almost nothing (battles last while the turn order is observed). */
const poke = makeSkill("poke", [makeEffect({ damageTerms: [{ source: "Attack", multiplier: 0.01 }] })]);

function formulasOf(mode: TurnOrderMode, extra: Record<string, unknown> = {}): ResolvedCombatFormula {
  return makeFormulas({ turnOrder: { mode, ...extra } });
}

function session(mode: TurnOrderMode, units: TestUnitSpec[], extra: Record<string, unknown> = {}): PveBattleSession {
  const formulas = formulasOf(mode, extra);
  return new PveBattleSession({
    state: buildBattleState(units, { formulas, seed: 7 }),
    pendingEnemyWaves: [],
    playerSideId: "players",
    enemySideId: "enemies",
    currentWaveIndex: 0,
    totalWaves: 1,
    engine: createTestEngine({ formulas }),
  });
}

/** Actors of the turns started in `events`, in order. */
function actors(events: BattleEvent[]): string[] {
  return eventsOfType(events, "turn_started").map((event) => event.actorId);
}

/** Plays auto until `count` turns started (collecting every event). */
function autoTurns(battle: PveBattleSession, first: PveBattleSessionStepResult, count: number): BattleEvent[] {
  const events = [...first.events];
  let result = first;
  while (actors(events).length < count && !result.finished && result.awaitingPlayerInput) {
    result = battle.usePlayerAuto();
    events.push(...result.events);
  }
  return events;
}

const unit = (id: string, side: string, spd: number, skills = [poke], extra: Partial<TestUnitSpec> = {}): TestUnitSpec =>
  ({ id, side, skills, stats: { spd, hp: 50000 }, ...extra });

describe("Turn order: configuration", () => {
  it("defaults to the attack bar and ignores unknown modes", () => {
    assert.equal(normalizeCombatFormulaSnapshot({}).turnOrder.mode, "AttackBar");
    assert.equal(normalizeCombatFormulaSnapshot({ turnOrder: { mode: "Initiative" } }).turnOrder.mode, "AttackBar");
    assert.equal(normalizeCombatFormulaSnapshot({ turnOrder: { mode: "TeamPhase" } }).turnOrder.mode, "TeamPhase");
    assert.equal(normalizeCombatFormulaSnapshot({ turnOrder: { teamPhaseSkipThreshold: 9 } }).turnOrder.teamPhaseSkipThreshold, 2);
    // Round-mode attack bar cap and Destroy cap come from the formula (defaults 3 and 0.6, clamped).
    assert.equal(normalizeCombatFormulaSnapshot({}).turnOrder.roundModeTurnBarCap, 3);
    assert.equal(normalizeCombatFormulaSnapshot({ turnOrder: { roundModeTurnBarCap: 50 } }).turnOrder.roundModeTurnBarCap, 10);
    assert.equal(normalizeCombatFormulaSnapshot({}).damage.destroyMaxHpCap, 0.6);
    assert.equal(normalizeCombatFormulaSnapshot({ damage: { destroyMaxHpCap: 2 } }).damage.destroyMaxHpCap, 1);
    const capped = formulasOf("SpeedRounds", { roundModeTurnBarCap: 2 });
    assert.equal(getTurnOrderSystem(capped).maxTurnBar({ turnThreshold: 100 } as never, normalizeCombatFormulaSnapshot(capped)), 200);
    assert.equal(getTurnOrderSystem(formulasOf("SpeedRounds")).mode, "SpeedRounds");
    assert.equal(getTurnOrderSystem(null).mode, "AttackBar");
  });

  it("previews the attack bar order without changing the state", () => {
    const formulas = makeFormulas();
    const state = buildBattleState([unit("A", "players", 200), unit("B", "players", 100), unit("E", "enemies", 150)], { formulas });
    const preview = new AttackBarTurnOrder().preview(state, formulas);
    assert.equal(preview.actorIds.length, 3);
    assert.equal(state.units.A.turnBar, 0, "the preview does not touch the state");

    const battle = session("AttackBar", [unit("A", "players", 200), unit("B", "players", 100), unit("E", "enemies", 150)]);
    const events = autoTurns(battle, battle.start(), 3);
    assert.deepEqual(actors(events).slice(0, 3), preview.actorIds);
    assert.deepEqual(actors(events).slice(0, 2), ["A", "E"]);
    assert.equal(eventsOfType(events, "turn_order").length, 0, "AttackBar emits no turn_order events");
    assert.equal(eventsOfType(events, "round_started").length, 0);
  });
});

describe("Turn order: SpeedRounds", () => {
  it("every unit acts once per round by speed; speed changes count from the next round", () => {
    const haste = makeSkill("haste", [statusEffect("SpeedUp", 3, { statusMagnitude: 1 })], { targetSide: "Ally", targeting: "AllAllies", cooldownByLevel: [5] });
    const battle = session("SpeedRounds", [
      unit("A", "players", 150, [haste, poke]),
      unit("B", "players", 90),
      unit("E1", "enemies", 120),
      unit("E2", "enemies", 100),
    ]);
    const events = autoTurns(battle, battle.start(), 8);
    // Round 1: A hastes its team (+100% SPD) but B still acts last; round 2: B (180) passes E1 and E2.
    assert.deepEqual(actors(events).slice(0, 8), ["A", "E1", "E2", "B", "A", "B", "E1", "E2"]);
    assert.deepEqual(eventsOfType(events, "round_started").map((event) => event.round).slice(0, 2), [1, 2]);
    const order = eventsOfType(events, "turn_order")[0];
    assert.deepEqual(order.actorIds, ["A", "E1", "E2", "B"]);
  });

  it("attack bar boosts move a unit forward proportionally; 100% = acts next", () => {
    const push = (amount: number) => makeSkill("push", [makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: amount, target: "AllAllies" })], { targetSide: "Ally" });
    const run = (amount: number) => {
      const battle = session("SpeedRounds", [
        unit("A", "players", 200, [push(amount)]),
        unit("E1", "enemies", 190), unit("E2", "enemies", 180), unit("E3", "enemies", 170), unit("E4", "enemies", 160),
        unit("B", "players", 100),
      ]);
      return actors(autoTurns(battle, battle.start(), 6)).slice(0, 6);
    };
    // 6 units: +40% = 2.4 places; +100% = right after the caster.
    assert.deepEqual(run(0.4), ["A", "E1", "E2", "B", "E3", "E4"]);
    assert.deepEqual(run(1), ["A", "B", "E1", "E2", "E3", "E4"]);
  });

  it("attack bar cuts push a unit back but it still acts this round; revived units wait for the next round", () => {
    const slowAll = makeSkill("slowall", [makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 1, target: "AllEnemies" })], { targeting: "AllEnemies" });
    const battle = session("SpeedRounds", [
      unit("A", "players", 200, [slowAll]),
      unit("B", "players", 100),
      unit("E1", "enemies", 190),
      unit("E2", "enemies", 150),
    ]);
    const events = autoTurns(battle, battle.start(), 4);
    assert.deepEqual(actors(events).slice(0, 4), ["A", "B", "E1", "E2"]);
  });

  it("extra turns act immediately and do not use the next round's action", () => {
    const tempo = makeSkill("tempo", [makeEffect({ damageTerms: [{ source: "Attack", multiplier: 0.01 }] }), makeEffect({ type: "ExtraTurn", damageTerms: [] })], { cooldownByLevel: [2] });
    const battle = session("SpeedRounds", [
      unit("A", "players", 200, [tempo, poke]),
      unit("E1", "enemies", 100),
    ]);
    const events = autoTurns(battle, battle.start(), 4);
    assert.deepEqual(actors(events).slice(0, 4), ["A", "A", "E1", "A"]);
    assert.equal(eventsOfType(events, "extra_turn_granted").length >= 1, true);
  });

  it("a unit revived during the round acts from the next round", () => {
    const formulas = formulasOf("SpeedRounds");
    const state = buildBattleState([unit("A", "players", 200), unit("B", "players", 100), unit("E", "enemies", 150)], { formulas });
    const turnOrder = getTurnOrderSystem(formulas);
    turnOrder.advance(state, formulas);
    assert.deepEqual(readRoundState(state).pending, ["A", "E", "B"]);
    state.units.B.currentHp = 0;
    turnOrder.onUnitRevived(state, state.units.B, formulas);
    assert.deepEqual(readRoundState(state).pending, ["A", "E"]);
  });
});

describe("Turn order: AlternatingSides", () => {
  it("alternates the sides (fastest side first) and lets the larger side finish", () => {
    const battle = session("AlternatingSides", [
      unit("P1", "players", 100), unit("P2", "players", 90), unit("P3", "players", 80),
      unit("E1", "enemies", 150),
    ]);
    const events = autoTurns(battle, battle.start(), 8);
    assert.deepEqual(actors(events).slice(0, 8), ["E1", "P1", "P2", "P3", "E1", "P1", "P2", "P3"]);
    const order = eventsOfType(events, "turn_order")[0];
    assert.equal(order.sideId, "enemies");
    assert.deepEqual(order.actorIds, ["E1", "P1", "P2", "P3"]);
  });

  it("attack bar boosts reorder a side's own queue", () => {
    const formulas = formulasOf("AlternatingSides");
    const state = buildBattleState([
      unit("P1", "players", 200), unit("P2", "players", 150), unit("P3", "players", 100),
      unit("E1", "enemies", 120), unit("E2", "enemies", 110),
    ], { formulas });
    const turnOrder = getTurnOrderSystem(formulas);
    turnOrder.advance(state, formulas);
    assert.deepEqual(turnOrder.preview(state, formulas).actorIds, ["P1", "E1", "P2", "E2", "P3"]);
    // +100% on P3 (3 players: 3 places) puts it first in the players' queue; the sides keep alternating.
    turnOrder.applyTurnBarChange(state.units.P3, 1000, formulas, true);
    assert.deepEqual(turnOrder.preview(state, formulas).actorIds, ["P3", "E1", "P1", "E2", "P2"]);
  });
});

describe("Turn order: TeamPhase", () => {
  const team = () => [
    unit("P1", "players", 130, [poke, makeSkill("boost", [makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 1 })], { targetSide: "Ally", cooldownByLevel: [3] })]),
    unit("P2", "players", 110),
    unit("P3", "players", 90),
    unit("E1", "enemies", 120, [poke, makeSkill("cut", [makeEffect({ type: "TurnBar", damageTerms: [], turnBarIncrease: false, turnBarAmount: 0.6 })], { cooldownByLevel: [3] })]),
    unit("E2", "enemies", 100),
  ];

  it("waits for the player to pick any ready unit, in any order", () => {
    const battle = session("TeamPhase", team());
    const start = battle.start();
    assert.equal(start.awaitingPlayerInput, true);
    assert.equal(start.phase, "waiting_for_turn");
    assert.equal(start.activeUnitId, null);
    assert.deepEqual(start.actorOptions?.map((option) => option.actorId), ["P1", "P2", "P3"]);
    assert.equal(start.actionOptions?.actorId, "P1");
    assert.equal(eventsOfType(start.events, "team_phase_started")[0].sideId, "players");

    const third = battle.usePlayerSkill({ actorId: "P3", skillId: "poke", targetId: "E1" });
    assert.equal(third.accepted, true);
    assert.deepEqual(actors(third.events), ["P3"]);
    assert.deepEqual(third.actorOptions?.map((option) => option.actorId), ["P1", "P2"]);

    const again = battle.usePlayerSkill({ actorId: "P3", skillId: "poke", targetId: "E1" });
    assert.equal(again.accepted, false);
    assert.equal(again.error, "ACTOR_NOT_READY");

    const wrongTarget = battle.usePlayerSkill({ actorId: "P2", skillId: "poke", targetId: "P1" });
    assert.equal(wrongTarget.accepted, false);
    assert.equal(eventsOfType(wrongTarget.events, "turn_started").length, 0, "an invalid command starts no turn");

    const boost = battle.usePlayerSkill({ actorId: "P1", skillId: "boost", targetId: "P3" });
    assert.deepEqual(boost.actorOptions?.map((option) => option.actorId), ["P2", "P3"], "+100% lets P3 act again this phase");
  });

  it("the enemy phase follows the player phase; AI and auto pick the fastest first", () => {
    const battle = session("TeamPhase", team());
    const events = autoTurns(battle, battle.start(), 5);
    assert.deepEqual(actors(events).slice(0, 5), ["P1", "P2", "P3", "E1", "E2"]);
    const phases = eventsOfType(events, "team_phase_started").map((event) => `${event.sideId}:${event.round}`);
    assert.deepEqual(phases.slice(0, 3), ["players:1", "enemies:1", "players:2"]);
  });

  it("an attack bar cut above the threshold makes a unit skip its next phase", () => {
    const battle = session("TeamPhase", team(), { teamPhaseSkipThreshold: 0.5 });
    let result = battle.start();
    for (const id of ["P1", "P2", "P3"]) result = battle.usePlayerSkill({ actorId: id, skillId: "poke", targetId: "E1" });
    // E1 cut P1's bar by 60% (> 50%): P1 skips the next players' phase.
    const cut = eventsOfType(result.events, "turn_bar_changed").find((event) => event.amount === -600 && event.targetId.startsWith("P"));
    assert.ok(cut, "E1 used its cut");
    assert.deepEqual(result.actorOptions?.map((option) => option.actorId).includes(cut.targetId), false);
  });

  it("stunned units take their skipped turn before the player picks", () => {
    const units = team();
    units[1].skills = [poke];
    const formulas = formulasOf("TeamPhase");
    const state = buildBattleState(units, { formulas, seed: 7 });
    state.units.P2.statuses.push({
      status: "Stun", remainingTurns: 1, magnitude: 0, percentPerTurn: 0, isBuff: false, isDispellable: true,
      stacks: 1, maxStacks: 1, uniqueTag: null, sourceId: "E1", value: null, skipNextTick: false, passiveId: null,
    });
    const battle = new PveBattleSession({
      state, pendingEnemyWaves: [], playerSideId: "players", enemySideId: "enemies", currentWaveIndex: 0, totalWaves: 1,
      engine: createTestEngine({ formulas }),
    });
    const start = battle.start();
    assert.deepEqual(eventsOfType(start.events, "turn_skipped").map((event) => event.actorId), ["P2"]);
    assert.deepEqual(start.actorOptions?.map((option) => option.actorId), ["P1", "P3"]);
  });
});

describe("Effect conditions on the caster's side read the primary target", () => {
  it("a BeforeAttack passive on Self checks the enemy being attacked", () => {
    const passive = { id: "opportunist", triggers: [{ trigger: "BeforeAttack" as const, chance: 1, target: "Self" as const, effects: [statusEffect("CritRateUp", 1, { condition: "TargetHasNoDebuff" })] }] };
    const run = (debuffed: boolean) => {
      const formulas = makeFormulas();
      const state = buildBattleState([
        { id: "A", side: "players", skills: [poke], turnBar: 1000, passives: [passive] },
        { id: "E", side: "enemies", skills: [poke] },
      ], { formulas });
      if (debuffed) {
        state.units.E.statuses.push({
          status: "Slow", remainingTurns: 2, magnitude: 0.3, percentPerTurn: 0, isBuff: false, isDispellable: true,
          stacks: 1, maxStacks: 1, uniqueTag: null, sourceId: "A", value: null, skipNextTick: false, passiveId: null,
        });
      }
      const engine = createTestEngine({ formulas });
      const started = engine.dispatch(engine.start(state).state, { type: "start_turn", actorId: "A" });
      const used = engine.dispatch(started.state, { type: "use_skill", actorId: "A", skillId: "poke", targetId: "E" });
      return eventsOfType(used.events, "status_applied").some((event) => event.status === "CritRateUp" && event.targetId === "A");
    };
    assert.equal(run(false), true, "the enemy has no harmful effect: crit rate up");
    assert.equal(run(true), false, "the enemy is debuffed: no crit rate up (the caster's own debuffs do not count)");
  });

  it("an ExtraTurn conditioned on the target's HP reads the enemy hit", () => {
    const finisher = makeSkill("finisher", [
      makeEffect({ damageTerms: [{ source: "Attack", multiplier: 0.01 }] }),
      makeEffect({ type: "ExtraTurn", damageTerms: [], condition: "TargetHpBelow", conditionValue: 0.5 }),
    ]);
    const run = (enemyHp: number) => {
      const formulas = makeFormulas();
      const state = buildBattleState([
        { id: "A", side: "players", skills: [finisher], turnBar: 1000 },
        { id: "E", side: "enemies", skills: [poke], stats: { hp: 1000 } },
      ], { formulas });
      state.units.E.currentHp = enemyHp;
      const engine = createTestEngine({ formulas });
      const started = engine.dispatch(engine.start(state).state, { type: "start_turn", actorId: "A" });
      const used = engine.dispatch(started.state, { type: "use_skill", actorId: "A", skillId: "finisher", targetId: "E" });
      return eventsOfType(used.events, "extra_turn_granted").length > 0;
    };
    assert.equal(run(400), true);
    assert.equal(run(900), false);
  });

  it("effects on enemies keep reading the unit that receives them", () => {
    const sweep = makeSkill("sweep", [statusEffect("Stun", 1, { condition: "TargetHpBelow", conditionValue: 0.5 })], { targeting: "AllEnemies" });
    const formulas = makeFormulas();
    const state = buildBattleState([
      { id: "A", side: "players", skills: [sweep], turnBar: 1000 },
      { id: "E1", side: "enemies", skills: [poke] },
      { id: "E2", side: "enemies", skills: [poke] },
    ], { formulas });
    state.units.E2.currentHp = 300;
    const engine = createTestEngine({ formulas });
    const started = engine.dispatch(engine.start(state).state, { type: "start_turn", actorId: "A" });
    const used = engine.dispatch(started.state, { type: "use_skill", actorId: "A", skillId: "sweep", targetId: "E1" });
    assert.deepEqual(eventsOfType(used.events, "status_applied").map((event) => event.targetId), ["E2"]);
  });
});

describe("Own cooldown and session robustness", () => {
  it("a self CooldownChange decrease resets the other skills but not the skill being used", () => {
    const formulas = makeFormulas();
    const reset = makeSkill("reset", [
      makeEffect({ type: "CooldownChange", damageTerms: [], cooldownIncrease: false, cooldownTurns: 5, buffCount: 0, target: "Self" }),
      makeEffect({ type: "ExtraTurn", damageTerms: [] }),
    ], { targetSide: "Self", cooldownByLevel: [4] });
    const nuke = makeSkill("nuke", [makeEffect()], { cooldownByLevel: [3] });
    const state = buildBattleState([
      { id: "A", side: "players", skills: [poke, nuke, reset], turnBar: 1000 },
      { id: "E", side: "enemies", skills: [poke] },
    ], { formulas });
    state.units.A.cooldowns = { nuke: 2 };
    const engine = createTestEngine({ formulas });
    const started = engine.dispatch(engine.start(state).state, { type: "start_turn", actorId: "A" });
    const used = engine.dispatch(started.state, { type: "use_skill", actorId: "A", skillId: "reset", targetId: "A" });
    assert.equal(used.state.units.A.cooldowns.nuke, 0, "the other skill is reset");
    assert.equal(used.state.units.A.cooldowns.reset, 3, "its own cooldown started (4) and only ticked at turn end");
    assert.equal(eventsOfType(used.events, "extra_turn_granted").length, 1);
  });

  it("auto-play resumes a session that ran out of its step budget instead of leaving it idle", () => {
    const loop = makeSkill("loop", [makeEffect({ type: "ExtraTurn", damageTerms: [] })], { targetSide: "Self" });
    const formulas = makeFormulas();
    const battle = new PveBattleSession({
      state: buildBattleState([
        { id: "P", side: "players", skills: [poke], stats: { hp: 900000, spd: 90 } },
        { id: "E", side: "enemies", skills: [loop], stats: { hp: 900000, spd: 150 } },
      ], { formulas, metadata: { turnLimit: 520 } }),
      pendingEnemyWaves: [], playerSideId: "players", enemySideId: "enemies", currentWaveIndex: 0, totalWaves: 1,
      engine: createTestEngine({ formulas }),
    });
    const stalled = battle.start();
    assert.equal(stalled.error, "AUTO_ADVANCE_STALLED");
    assert.equal(stalled.finished, false);
    const resumed = battle.usePlayerAuto();
    assert.equal(resumed.accepted, true);
    assert.equal(resumed.finished, true);
    assert.equal(resumed.finishedReason, "turn_limit");
  });
});
