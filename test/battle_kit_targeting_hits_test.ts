import assert from "node:assert/strict";

import { BattleEngine, PveBattleRuleset, StaticCombatFormulaProvider, hasStatus, type BattleState } from "../src/modules/battle-core";
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
  type TestUnitSpec,
} from "./helpers/battle-test-kit";

const strike = () => makeSkill("strike", [makeEffect()]);

function arena(specs: Partial<Record<"A" | "B" | "E1" | "E2" | "E3", Partial<TestUnitSpec>>> = {}): BattleState {
  return buildBattleState([
    { id: "A", side: "players", skills: [strike()], turnBar: 1000, ...(specs.A ?? {}) },
    { id: "B", side: "players", skills: [strike()], ...(specs.B ?? {}) },
    { id: "E1", side: "enemies", skills: [strike()], ...(specs.E1 ?? {}) },
    { id: "E2", side: "enemies", skills: [strike()], ...(specs.E2 ?? {}) },
    { id: "E3", side: "enemies", skills: [strike()], ...(specs.E3 ?? {}) },
  ]);
}

function useSkill(state: BattleState, skillId: string, targetId: string, engine: BattleEngine = createTestEngine()) {
  const turn = startTurnOf(engine, state, "A");
  return engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId, targetId });
}

describe("Targeting authority", () => {
  it("validates target side, alive/dead and forces self skills onto the caster", () => {
    const heal = makeSkill("heal", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1 })]);
    const revive = makeSkill("revive", [makeEffect({ type: "Revive", damageTerms: [], reviveHpPercent: 0.5 })]);
    const selfBuff = makeSkill("focus", [statusEffect("AttackUp", 2)], { targetSide: "Self" });
    const state = arena({ A: { skills: [strike(), heal, revive, selfBuff] } });
    state.units.E2.currentHp = 0;
    state.units.B.currentHp = 0;

    assert.equal(useSkill(state, "strike", "B").error, "INVALID_TARGET_SIDE");
    assert.equal(useSkill(state, "strike", "E2").error, "TARGET_DEAD");
    assert.equal(useSkill(state, "strike", "ghost").error, "INVALID_TARGET");
    assert.equal(useSkill(state, "strike", "__proto__").error, "INVALID_TARGET");
    assert.equal(useSkill(state, "heal", "E1").error, "INVALID_TARGET_SIDE");
    assert.equal(useSkill(state, "heal", "B").error, "TARGET_DEAD");

    const revived = useSkill(state, "revive", "B");
    assert.equal(revived.accepted, true);
    assert.equal(revived.state.units.B.currentHp, 500);

    const focused = useSkill(state, "focus", "E1");
    assert.equal(focused.accepted, true);
    assert.equal(hasStatus(focused.state.units.A, "AttackUp"), true);
    assert.equal(eventsOfType(focused.events, "skill_used")[0].primaryTargetId, "A");
  });

  it("enforces the allowed line while the target side still has units in that line", () => {
    const front = makeSkill("front", [makeEffect()], { allowedLine: "FrontlineOnly" });
    const back = makeSkill("back", [makeEffect()], { allowedLine: "BacklineOnly" });
    const state = arena({
      A: { skills: [front, back] },
      E1: { line: "Frontline" },
      E2: { line: "Backline" },
      E3: { line: "Frontline" },
    });

    assert.equal(useSkill(state, "front", "E2").error, "INVALID_TARGET_LINE");
    assert.equal(useSkill(state, "back", "E1").error, "INVALID_TARGET_LINE");
    assert.equal(useSkill(state, "back", "E2").accepted, true);

    state.units.E1.currentHp = 0;
    state.units.E3.currentHp = 0;
    assert.equal(useSkill(state, "front", "E2").accepted, true);
  });

  it("resolves AllEnemies, AllAllies and RandomEnemies targeting", () => {
    const aoe = makeSkill("aoe", [makeEffect()], { targeting: "AllEnemies" });
    const groupHeal = makeSkill("group_heal", [makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1 })], { targeting: "AllAllies" });
    const random = makeSkill("random", [makeEffect()], { targeting: "RandomEnemies", randomTargetCount: 2 });
    const state = arena({ A: { skills: [aoe, groupHeal, random] } });
    state.units.A.currentHp = 100;
    state.units.B.currentHp = 100;

    const hitAll = useSkill(state, "aoe", "E2");
    assert.deepEqual(eventsOfType(hitAll.events, "skill_used")[0].targetIds, ["E1", "E2", "E3"]);
    assert.equal(eventsOfType(hitAll.events, "damage_applied").length, 3);

    const healed = useSkill(state, "group_heal", "B");
    assert.deepEqual(eventsOfType(healed.events, "heal_applied").map((event) => event.targetId), ["A", "B"]);

    const randomHit = useSkill(state, "random", "E1", createTestEngine({ rng: 7 }));
    const targets = eventsOfType(randomHit.events, "skill_used")[0].targetIds;
    assert.equal(targets.length, 2);
    assert.notEqual(targets[0], targets[1]);
  });

  it("supports per-effect target scopes", () => {
    const rally = makeSkill("rally", [
      makeEffect(),
      statusEffect("AttackUp", 2, { target: "AllAllies" }),
      makeEffect({ type: "Heal", damageTerms: [], healScale: 0.1, target: "LowestHpAlly" }),
    ]);
    const state = arena({ A: { skills: [rally] } });
    state.units.B.currentHp = 300;
    const result = useSkill(state, "rally", "E1");

    assert.equal(result.state.units.E1.currentHp, 950);
    assert.equal(hasStatus(result.state.units.A, "AttackUp"), true);
    assert.equal(hasStatus(result.state.units.B, "AttackUp"), true);
    assert.equal(hasStatus(result.state.units.E1, "AttackUp"), false);
    assert.deepEqual(eventsOfType(result.events, "heal_applied").map((event) => event.targetId), ["B"]);
  });

  it("evaluates OnCrit and TargetHpBelow conditions", () => {
    const critBoost = makeSkill("crit_boost", [
      makeEffect(),
      makeEffect({ type: "TurnBar", damageTerms: [], turnBarAmount: 0.5, target: "Self", condition: "OnCrit" }),
    ]);
    const execute = makeSkill("execute", [statusEffect("Stun", 1, { condition: "TargetHpBelow", conditionValue: 0.5 })]);

    const critState = arena({ A: { skills: [critBoost], stats: { cr: 1 } } });
    assert.equal(useSkill(critState, "crit_boost", "E1").state.units.A.turnBar, 500);
    const noCritState = arena({ A: { skills: [critBoost] } });
    assert.equal(useSkill(noCritState, "crit_boost", "E1").state.units.A.turnBar, 0);

    const low = arena({ A: { skills: [execute] } });
    low.units.E1.currentHp = 400;
    assert.equal(hasStatus(useSkill(low, "execute", "E1").state.units.E1, "Stun"), true);
    low.units.E1.currentHp = 600;
    assert.equal(hasStatus(useSkill(low, "execute", "E1").state.units.E1, "Stun"), false);
  });
});

describe("Hits, multi-hit and harmful effect gating", () => {
  const stunStrike = () => makeSkill("stun_strike", [makeEffect(), statusEffect("Stun", 1)]);

  it("harmful effects after a damage effect only apply to targets that were hit without glancing", () => {
    const missEngine = createTestEngine({ formulas: makeFormulas({ accuracy: { baseHitChance: 0 } }) });
    const missed = useSkill(arena({ A: { skills: [stunStrike()] } }), "stun_strike", "E1", missEngine);
    assert.equal(eventsOfType(missed.events, "attack_missed")[0].reason, "evasion");
    assert.equal(hasStatus(missed.state.units.E1, "Stun"), false);

    const glanceEngine = createTestEngine({ rng: new ScriptedRandom([0.1]) });
    const glanced = useSkill(arena({ A: { skills: [stunStrike()], element: "fire" }, E1: { element: "water" } }), "stun_strike", "E1", glanceEngine);
    const hit = eventsOfType(glanced.events, "damage_applied")[0];
    assert.equal(hit.isGlancing, true);
    assert.equal(hit.elementRelation, -1);
    assert.equal(hit.amount, 35);
    assert.equal(hasStatus(glanced.state.units.E1, "Stun"), false);

    const landed = useSkill(arena({ A: { skills: [stunStrike()] } }), "stun_strike", "E1");
    assert.equal(hasStatus(landed.state.units.E1, "Stun"), true);
  });

  it("resolves every hit separately and repeats applyEverySplit effects per landed hit", () => {
    const tripleDot = makeSkill("triple", [
      makeEffect({ hits: 3 }),
      statusEffect("ContinuousDamage", 2, { applyEverySplit: true }),
      statusEffect("AttackBreak", 2),
    ]);
    const result = useSkill(arena({ A: { skills: [tripleDot] } }), "triple", "E1");
    const hits = eventsOfType(result.events, "damage_applied");
    assert.deepEqual(hits.map((event) => [event.hitIndex, event.hitCount, event.amount]), [[0, 3, 50], [1, 3, 50], [2, 3, 50]]);
    assert.equal(result.state.units.E1.statuses.filter((entry) => entry.status === "ContinuousDamage").length, 3);
    assert.equal(result.state.units.E1.statuses.filter((entry) => entry.status === "AttackBreak").length, 1);
  });

  it("applies elemental advantage crit bonus and crushing hits, disadvantage glancing and crit penalty", () => {
    const fireVsWind = (rolls: number[], aStats: any = {}) => useSkill(
      arena({ A: { element: "fire", stats: aStats }, E1: { element: "wind" } }),
      "strike",
      "E1",
      createTestEngine({ rng: new ScriptedRandom(rolls) })
    );
    const crit = eventsOfType(fireVsWind([0.1]).events, "damage_applied")[0];
    assert.deepEqual([crit.isCritical, crit.isCrushing, crit.amount], [true, false, 75]);
    const crushing = eventsOfType(fireVsWind([0.2]).events, "damage_applied")[0];
    assert.deepEqual([crushing.isCritical, crushing.isCrushing, crushing.amount, crushing.elementRelation], [false, true, 65, 1]);

    const fireVsWater = (rolls: number[]) => useSkill(
      arena({ A: { element: "fire", stats: { cr: 0.2 } }, E1: { element: "water" } }),
      "strike",
      "E1",
      createTestEngine({ rng: new ScriptedRandom(rolls) })
    );
    const lowCrit = eventsOfType(fireVsWater([0.6, 0.04]).events, "damage_applied")[0];
    assert.deepEqual([lowCrit.isGlancing, lowCrit.isCritical, lowCrit.amount], [false, true, 75]);
    const normal = eventsOfType(fireVsWater([0.6, 0.06]).events, "damage_applied")[0];
    assert.deepEqual([normal.isGlancing, normal.isCritical, normal.isCrushing, normal.amount], [false, false, false, 50]);

    const cdEngine = createTestEngine({ formulas: makeFormulas({ damage: { useCriticalDamageStat: true } }) });
    const cdHit = useSkill(arena({ A: { stats: { cr: 1, cd: 2 } } }), "strike", "E1", cdEngine);
    assert.equal(eventsOfType(cdHit.events, "damage_applied")[0].amount, 100);
  });

  it("uses the resistance formula max(15%, RES - ACC) after the base chance", () => {
    const debuff = makeSkill("debuff", [statusEffect("AttackBreak", 2)]);
    const halfDebuff = makeSkill("half", [statusEffect("AttackBreak", 2, { applyChance: 0.5 })]);
    const resistFloor = makeFormulas({ accuracy: { minimumResistChance: 0.15 } });
    const run = (skill: any, rolls: number[], formulas = resistFloor, res = 0.5) => useSkill(
      arena({ A: { skills: [skill], stats: { acc: 0.1 } }, E1: { stats: { res } } }),
      skill.id,
      "E1",
      createTestEngine({ formulas, rng: new ScriptedRandom(rolls) })
    );

    const resisted = run(debuff, [0.39]);
    assert.equal(eventsOfType(resisted.events, "status_blocked")[0].reason, "RESISTED");
    assert.equal(hasStatus(run(debuff, [0.41]).state.units.E1, "AttackBreak"), true);
    assert.equal(hasStatus(run(debuff, [0.14], resistFloor, 0).state.units.E1, "AttackBreak"), false);
    assert.equal(hasStatus(run(debuff, [0.16], resistFloor, 0).state.units.E1, "AttackBreak"), true);

    const failed = run(halfDebuff, [0.6]);
    assert.equal(eventsOfType(failed.events, "status_blocked").length, 0);
    assert.equal(hasStatus(failed.state.units.E1, "AttackBreak"), false);

    const linear = makeFormulas({ accuracy: { debuffResistanceModel: "linear" } });
    assert.equal(hasStatus(run(debuff, [0.59], linear).state.units.E1, "AttackBreak"), true);
    assert.equal(hasStatus(run(debuff, [0.61], linear).state.units.E1, "AttackBreak"), false);
  });
});

describe("Engine authority and determinism", () => {
  it("uses the roster skill level and applies the cooldown semantics", () => {
    const big = makeSkill("big", [makeEffect()], { maxSkillLevel: 3, cooldownByLevel: [3, 2, 1] });
    const state = arena({ A: { skills: [strike(), big] } });
    const engine = createTestEngine();
    let current = startTurnOf(engine, state, "A").state;
    const used = engine.dispatch(current, { type: "use_skill", actorId: "A", skillId: "big", targetId: "E1" });
    assert.equal(eventsOfType(used.events, "skill_used")[0].skillLevel, 1);
    assert.equal(used.state.units.A.cooldowns.big, 2);

    current = used.state;
    for (let turn = 0; turn < 2; turn++) {
      current.units.A.turnBar = 1000;
      current = engine.dispatch(current, { type: "start_turn", actorId: "A" }).state;
      assert.equal(engine.dispatch(current, { type: "use_skill", actorId: "A", skillId: "big", targetId: "E1" }).error, "SKILL_ON_COOLDOWN");
      current = engine.dispatch(current, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E1" }).state;
    }
    current.units.A.turnBar = 1000;
    current = engine.dispatch(current, { type: "start_turn", actorId: "A" }).state;
    assert.equal(engine.dispatch(current, { type: "use_skill", actorId: "A", skillId: "big", targetId: "E1" }).accepted, true);
  });

  it("ends the battle as a draw when the turn limit is reached", () => {
    const state = arena();
    state.metadata.turnLimit = 1;
    const engine = createTestEngine();
    const turn = startTurnOf(engine, state, "A");
    const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E1" });
    assert.equal(result.state.phase, "finished");
    assert.equal(result.state.winnerSideId, null);
    assert.equal(result.state.finishedReason, "turn_limit");
    assert.equal(eventsOfType(result.events, "battle_finished")[0].reason, "turn_limit");
  });

  it("persists the RNG in the state so dispatching is a pure function of (state, command)", () => {
    const random = makeSkill("random", [makeEffect({ hits: 3 })], { targeting: "RandomEnemies", randomTargetCount: 1 });
    const state = arena({ A: { skills: [random], stats: { cr: 0.5 } } });
    state.metadata.seed = "replay-seed";
    const engine = new BattleEngine(new PveBattleRuleset(), {
      combatFormulaProvider: new StaticCombatFormulaProvider(makeFormulas()),
    });

    const run = () => {
      const turn = startTurnOf(engine, state, "A");
      return engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "random", targetId: "E1" });
    };
    const first = run();
    const second = run();
    assert.deepEqual(first.events, second.events);
    assert.deepEqual(first.state, second.state);
    assert.equal(typeof first.state.metadata.rngState, "number");
  });
});
