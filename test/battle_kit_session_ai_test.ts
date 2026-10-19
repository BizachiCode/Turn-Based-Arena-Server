import assert from "node:assert/strict";

import {
  PveBattleSession,
  decideAiCommand,
  type BattleActiveStatus,
  type BattleUnitState,
  type PveBattleSessionStepResult,
} from "../src/modules/battle-core";
import { BattlePveSession } from "../src/modules/battle-pve";
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

const strike = (multiplier = 1) => makeSkill("strike", [makeEffect({ damageTerms: [{ source: "Attack", multiplier }] })]);

function debuff(statusId: BattleActiveStatus["status"]): BattleActiveStatus {
  return {
    status: statusId,
    remainingTurns: 2,
    magnitude: 0,
    percentPerTurn: 0,
    isBuff: false,
    isDispellable: true,
    stacks: 1,
    maxStacks: 1,
    sourceId: "X",
  };
}

function waveUnits(specs: TestUnitSpec[]): BattleUnitState[] {
  const state = buildBattleState([{ id: "dummy", side: "players", skills: [strike()] }, ...specs]);
  return specs.map((spec) => state.units[spec.id]);
}

function createSession(players: TestUnitSpec[], enemies: TestUnitSpec[], waves: TestUnitSpec[][] = [], seed = "session-seed") {
  const state = buildBattleState([...players, ...enemies], { seed, metadata: { totalWaves: waves.length + 1 } });
  return new PveBattleSession({
    state,
    pendingEnemyWaves: waves.map(waveUnits),
    playerSideId: "players",
    enemySideId: "enemies",
    currentWaveIndex: 0,
    totalWaves: waves.length + 1,
    engine: createTestEngine({ formulas: makeFormulas({ accuracy: { minimumResistChance: 0.15 } }) }),
  });
}

function autoPlay(session: PveBattleSession, first: PveBattleSessionStepResult, maxSteps = 200) {
  const steps = [first];
  let current = first;
  for (let i = 0; i < maxSteps && !current.finished; i++) {
    current = session.usePlayerAuto();
    steps.push(current);
    assert.equal(current.accepted, true, current.error);
  }
  return steps;
}

describe("PvE session", () => {
  it("advances to the player's turn and exposes action options", () => {
    const big = makeSkill("big", [makeEffect()], { cooldownByLevel: [3] });
    const session = createSession(
      [{ id: "P1", side: "players", skills: [strike(), big], stats: { spd: 200 } }],
      [{ id: "E1", side: "enemies", skills: [strike()] }]
    );
    const started = session.start();

    assert.equal(started.accepted, true);
    assert.equal(started.awaitingPlayerInput, true);
    assert.equal(started.activeUnitId, "P1");
    assert.equal(started.phase, "awaiting_action");
    assert.equal(started.finished, false);
    assert.equal(started.victory, null);
    assert.deepEqual(started.actionOptions?.skills.map((skill) => [skill.skillId, skill.usable, skill.targetSide, skill.targetIds]), [
      ["strike", true, "Enemy", ["E1"]],
      ["big", true, "Enemy", ["E1"]],
    ]);
    assert.equal(started.events[0].type, "wave_started");
  });

  it("auto-plays the player unit with the server AI and rejects auto when not awaiting input", () => {
    const session = createSession(
      [{ id: "P1", side: "players", skills: [strike(30)], stats: { spd: 200 } }],
      [{ id: "E1", side: "enemies", skills: [strike()] }]
    );
    session.start();
    const auto = session.usePlayerAuto();
    assert.equal(auto.accepted, true);
    assert.equal(auto.finished, true);
    assert.equal(auto.victory, true);
    assert.equal(auto.winnerSideId, "players");
    assert.equal(session.getLastAiDecision(), "attack");
    assert.equal(session.usePlayerAuto().error, "NOT_AWAITING_PLAYER_INPUT");
  });

  it("surrender ends the battle as a defeat", () => {
    const session = createSession(
      [{ id: "P1", side: "players", skills: [strike()], stats: { spd: 200 } }],
      [{ id: "E1", side: "enemies", skills: [strike()] }]
    );
    session.start();
    const result = session.surrender();
    assert.equal(result.accepted, true);
    assert.equal(result.finished, true);
    assert.equal(result.victory, false);
    assert.equal(result.finishedReason, "surrender");
    assert.equal(result.actionOptions, null);
  });

  it("spawns waves: removes the dead, resets every turn bar to 0 and keeps survivors' statuses", () => {
    const session = createSession(
      [
        { id: "P1", side: "players", skills: [strike(30)], stats: { spd: 200 } },
        { id: "P2", side: "players", skills: [strike()], stats: { spd: 150 } },
      ],
      [{ id: "E1", side: "enemies", skills: [strike()], stats: { spd: 50 } }],
      [[{ id: "W2", side: "enemies", skills: [strike()], stats: { spd: 50 } }]]
    );
    const started = session.start();
    started.state.units.P2.statuses.push({ ...debuff("AttackBreak"), remainingTurns: 5 });

    const killed = session.usePlayerSkill({ actorId: "P1", skillId: "strike", targetId: "E1" });
    assert.equal(killed.accepted, true);
    const cleared = eventsOfType(killed.events, "wave_cleared")[0];
    assert.deepEqual(cleared.removedUnitIds, ["E1"]);
    const types = killed.events.map((event) => event.type);
    assert.ok(types.indexOf("wave_cleared") < types.indexOf("wave_started"));
    assert.equal(killed.currentWaveIndex, 1);
    assert.equal(killed.state.units.E1, undefined);
    assert.ok(killed.state.units.W2);
    assert.equal(killed.state.metadata.pendingEnemyWaveCount, 0);
    assert.equal(killed.state.units.P2.statuses.some((entry) => entry.status === "AttackBreak"), true);

    const resets = eventsOfType(killed.events, "turn_bar_changed").filter((event) => event.currentTurnBar === 0 && event.targetId === "P2");
    assert.ok(resets.length >= 1);

    const steps = autoPlay(session, killed);
    assert.equal(steps[steps.length - 1].victory, true);
  });

  it("replays a battle from its initial state and player commands", () => {
    const players: TestUnitSpec[] = [
      { id: "P1", side: "players", skills: [strike(), makeSkill("aoe", [makeEffect(), statusEffect("DefenseBreak", 2)], { targeting: "AllEnemies", cooldownByLevel: [3] })], stats: { spd: 120, cr: 0.3 } },
      { id: "P2", side: "players", skills: [strike(), makeSkill("heal", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.2 })], { targeting: "AllAllies", cooldownByLevel: [2] })], stats: { spd: 110 } },
    ];
    const enemies: TestUnitSpec[] = [
      { id: "E1", side: "enemies", skills: [makeSkill("bite", [makeEffect({ hits: 2 }), statusEffect("ContinuousDamage", 2, { applyChance: 0.5 })])], stats: { spd: 105, hp: 1500, acc: 0.2 } },
      { id: "E2", side: "enemies", skills: [strike(1.5)], stats: { spd: 90, hp: 1200 } },
    ];
    const session = createSession(players, enemies, [[{ id: "W2", side: "enemies", skills: [strike(2)], stats: { spd: 130, hp: 2000 } }]]);
    const first = session.start();
    const steps = autoPlay(session, first);
    assert.equal(steps[steps.length - 1].finished, true);

    const replay = session.getReplay();
    const again = new PveBattleSession({
      state: replay.initialState,
      pendingEnemyWaves: replay.pendingEnemyWaves,
      playerSideId: replay.playerSideId,
      enemySideId: replay.enemySideId,
      currentWaveIndex: replay.currentWaveIndex,
      totalWaves: replay.totalWaves,
      engine: createTestEngine({ formulas: makeFormulas({ accuracy: { minimumResistChance: 0.15 } }) }),
    });
    const replayed = [again.start()];
    for (const command of replay.commands) {
      if (command.type === "auto") replayed.push(again.usePlayerAuto());
      else if (command.type === "surrender") replayed.push(again.surrender());
      else replayed.push(again.usePlayerSkill(command));
    }

    assert.deepEqual(replayed.map((step) => step.events), steps.map((step) => step.events));
    assert.deepEqual(again.getState(), session.getState());
  });

  it("server session wrapper keeps the BattlePveSession API", () => {
    const state = buildBattleState([
      { id: "P1", side: "players", skills: [strike(30)], stats: { spd: 200 } },
      { id: "E1", side: "enemies", skills: [strike()] },
    ]);
    const session = new BattlePveSession({
      state,
      pendingEnemyWaves: [],
      playerSideId: "players",
      enemySideId: "enemies",
      currentWaveIndex: 0,
      totalWaves: 1,
    });
    const started = session.start();
    assert.equal(started.awaitingPlayerInput, true);
    assert.equal(session.usePlayerSkill({ actorId: "P1", skillId: "strike", targetId: "E1" }).victory, true);
  });
});

describe("Deterministic AI", () => {
  function decide(specs: TestUnitSpec[], actorId: string, mutate?: (state: any) => void) {
    const state = buildBattleState(specs);
    mutate?.(state);
    state.phase = "awaiting_action";
    state.actingUnitId = actorId;
    return decideAiCommand(state, actorId, makeFormulas());
  }

  const heal = makeSkill("heal", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.3 })], { cooldownByLevel: [3] });
  const revive = makeSkill("revive", [makeEffect({ type: "Revive", damageTerms: [] })], { cooldownByLevel: [5] });
  const cleanse = makeSkill("cleanse", [makeEffect({ type: "Cleanse", damageTerms: [], buffCount: 0 })], { cooldownByLevel: [3] });
  const buff = makeSkill("buff", [statusEffect("AttackUp", 2)], { targeting: "AllAllies", cooldownByLevel: [4] });
  const big = makeSkill("big", [makeEffect({ damageTerms: [{ source: "Attack", multiplier: 3 }] })], { cooldownByLevel: [4] });

  it("prioritizes revive, then heal below 50%, then cleanse, then buff, then attack", () => {
    const support = (extra: Partial<TestUnitSpec> = {}): TestUnitSpec[] => [
      { id: "S", side: "players", skills: [strike(), heal, revive, cleanse, buff], ...extra },
      { id: "A", side: "players", skills: [strike()] },
      { id: "B", side: "players", skills: [strike()] },
      { id: "E", side: "enemies", skills: [strike()] },
    ];

    const revived = decide(support(), "S", (state) => { state.units.B.currentHp = 0; state.units.A.currentHp = 100; });
    assert.equal(revived.kind, "revive");
    assert.deepEqual(revived.command, { type: "use_skill", actorId: "S", skillId: "revive", targetId: "B" });

    const healed = decide(support(), "S", (state) => { state.units.A.currentHp = 400; state.units.B.currentHp = 300; });
    assert.equal(healed.kind, "heal");
    assert.equal((healed.command as any).targetId, "B");

    const cleansed = decide(support(), "S", (state) => { state.units.A.statuses.push(debuff("Slow")); state.units.B.currentHp = 600; });
    assert.equal(cleansed.kind, "cleanse");
    assert.equal((cleansed.command as any).targetId, "A");

    const buffed = decide(support(), "S");
    assert.equal(buffed.kind, "buff");
    assert.equal((buffed.command as any).skillId, "buff");

    const attacked = decide(support(), "S", (state) => {
      for (const id of ["S", "A", "B"]) state.units[id].statuses.push({ ...debuff("AttackUp"), isBuff: true, remainingTurns: 3 });
    });
    assert.equal(attacked.kind, "attack");
  });

  it("attacks with the highest-cooldown ready skill, preferring elemental advantage then low HP", () => {
    const specs: TestUnitSpec[] = [
      { id: "A", side: "players", skills: [strike(), big], element: "fire" },
      { id: "E1", side: "enemies", skills: [strike()], element: "fire" },
      { id: "E2", side: "enemies", skills: [strike()], element: "wind" },
      { id: "E3", side: "enemies", skills: [strike()], element: "fire" },
    ];
    const advantage = decide(specs, "A", (state) => { state.units.E1.currentHp = 100; });
    assert.deepEqual(advantage.command, { type: "use_skill", actorId: "A", skillId: "big", targetId: "E2" });

    const lowHp = decide(specs, "A", (state) => {
      state.units.E2.element = "fire";
      state.units.E2.elementId = "fire";
      state.units.E3.currentHp = 200;
      state.units.A.cooldowns.big = 2;
    });
    assert.deepEqual(lowHp.command, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E3" });
  });
});
