import assert from "node:assert/strict";

import { ArenaBattleRuleset } from "../src/modules/battle-core";
import { PvpBattleSession } from "../src/modules/battle-pvp/pvp-battle-session";
import { buildPvpFrame } from "../src/modules/battle-pvp/pvp-frames";
import { buildBattleState, createTestEngine, makeEffect, makeFormulas, makeSkill } from "./helpers/battle-test-kit";

const strike = makeSkill("strike", [makeEffect({ damageTerms: [{ source: "Attack", multiplier: 1 }] })]);

export function pvpTestState(battleId = "pvp-test") {
  return buildBattleState([
    { id: "a-1", side: "side_a", skills: [strike], stats: { hp: 900, atk: 300, def: 100, spd: 130 }, metadata: { rosterUid: "uid-a1", equippedRuneUids: ["r1"] } },
    { id: "a-2", side: "side_a", skills: [strike], stats: { hp: 900, atk: 300, def: 100, spd: 100 }, metadata: { rosterUid: "uid-a2" } },
    { id: "b-1", side: "side_b", skills: [strike], stats: { hp: 900, atk: 300, def: 100, spd: 115 }, metadata: { rosterUid: "uid-b1" } },
  ], { battleId, mode: "arena", playerSide: "side_a", seed: 11 });
}

export function pvpTestSession(battleId?: string) {
  return new PvpBattleSession({
    state: pvpTestState(battleId),
    engine: createTestEngine({ ruleset: new ArenaBattleRuleset(), rng: 7 }),
    sideIds: ["side_a", "side_b"],
  });
}

describe("PvP battle session (two human sides)", () => {
  it("waits for whichever side must act and refuses the other one", () => {
    const session = pvpTestSession();
    const first = session.start();
    assert.equal(first.accepted, true);
    assert.equal(first.awaitingSideId, "side_a");
    assert.equal(first.actionOptions?.actorId, "a-1", "fastest unit first");
    assert.equal(first.seq, 1);

    const refused = session.useSkill("side_b", { actorId: "b-1", skillId: "strike", targetId: "a-1" });
    assert.equal(refused.accepted, false);
    assert.equal(refused.error, "NOT_YOUR_TURN");
    assert.equal(refused.seq, 1, "a refused command is not a new step");
    assert.equal(session.useSkill("side_a", { actorId: "b-1", skillId: "strike", targetId: "a-1" }).error, "INVALID_PLAYER_ACTOR");

    const second = session.useSkill("side_a", { actorId: "a-1", skillId: "strike", targetId: "b-1" });
    assert.equal(second.accepted, true);
    assert.equal(second.seq, 2);
    assert.equal(second.awaitingSideId, "side_b");
    assert.equal(second.actionOptions?.actorId, "b-1");
    assert.ok(second.events.some((event) => event.type === "skill_used" || event.type === "damage_applied"));
  });

  it("auto plays the awaiting unit and the battle ends with a winner side", () => {
    const session = pvpTestSession();
    let step = session.start();
    for (let guard = 0; guard < 200 && !step.finished; guard++) step = session.auto(step.awaitingSideId!);
    assert.equal(step.finished, true);
    assert.ok(step.winnerSideId === "side_a" || step.winnerSideId === "side_b");
    assert.equal(step.awaitingSideId, null);
    assert.equal(session.auto("side_a").error, "NOT_YOUR_TURN");
    assert.ok(session.getReplay().commands.length > 0);
  });

  it("TeamPhase: the side of the phase picks its units, then the other side's phase waits for the other player", () => {
    const formulas = makeFormulas({ turnOrder: { mode: "TeamPhase" } });
    const state = buildBattleState([
      { id: "a-1", side: "side_a", skills: [strike], stats: { hp: 5000, atk: 100, def: 100, spd: 130 } },
      { id: "a-2", side: "side_a", skills: [strike], stats: { hp: 5000, atk: 100, def: 100, spd: 100 } },
      { id: "b-1", side: "side_b", skills: [strike], stats: { hp: 5000, atk: 100, def: 100, spd: 110 } },
      { id: "b-2", side: "side_b", skills: [strike], stats: { hp: 5000, atk: 100, def: 100, spd: 90 } },
    ], { mode: "arena", playerSide: "side_a", seed: 3, formulas });
    const session = new PvpBattleSession({ state, engine: createTestEngine({ ruleset: new ArenaBattleRuleset(), formulas, rng: 5 }), sideIds: ["side_a", "side_b"] });

    let step = session.start();
    const firstSide = step.awaitingSideId!;
    const otherSide = firstSide === "side_a" ? "side_b" : "side_a";
    assert.equal(step.turnOrder.mode, "TeamPhase");
    assert.deepEqual(step.actorOptions?.map((options) => options.actorId).sort(), firstSide === "side_a" ? ["a-1", "a-2"] : ["b-1", "b-2"]);
    assert.equal(session.useSkill(otherSide, { actorId: otherSide === "side_a" ? "a-1" : "b-1", skillId: "strike", targetId: firstSide === "side_a" ? "a-1" : "b-1" }).error, "NOT_YOUR_TURN");

    // The phase side may start with its slower unit.
    const slower = firstSide === "side_a" ? "a-2" : "b-2";
    const target = firstSide === "side_a" ? "b-1" : "a-1";
    step = session.useSkill(firstSide, { actorId: slower, skillId: "strike", targetId: target });
    assert.equal(step.accepted, true, step.error);
    assert.equal(step.awaitingSideId, firstSide, "one unit of the phase is left");
    step = session.auto(firstSide);
    assert.equal(step.awaitingSideId, otherSide, "the other side's phase");
    assert.equal(step.actorOptions?.length, 2);
  });

  it("either side may surrender at any time", () => {
    const session = pvpTestSession();
    session.start();
    const step = session.surrender("side_b");
    assert.equal(step.finished, true);
    assert.equal(step.winnerSideId, "side_a");
    assert.equal(session.surrender("side_a").error, "BATTLE_ALREADY_FINISHED");
  });

  it("each player's frame shows their own side, hides the opponent's identities and only their own options", () => {
    const session = pvpTestSession();
    const step = session.start();
    const forA = buildPvpFrame(step, "side_a", { matchId: "M1", turnDeadlineUnix: 123 });
    const forB = buildPvpFrame(step, "side_b", { matchId: "M1", turnDeadlineUnix: 123 });

    assert.equal(forA.awaitingPlayerInput, true);
    assert.equal(forA.actionOptions?.actorId, "a-1");
    assert.equal(forB.awaitingPlayerInput, false);
    assert.equal(forB.actionOptions, null);
    assert.equal(forB.localSideId, "side_b");
    assert.deepEqual(forB.state.teams.map((team) => [team.sideId, team.isPlayerControlled]), [["side_a", false], ["side_b", true]]);
    assert.equal(forB.state.metadata.playerSideId, "side_b");
    assert.equal((forB.state.units["a-1"].metadata as any).rosterUid, undefined, "opponent roster uid stripped");
    assert.equal((forB.state.units["a-1"].metadata as any).equippedRuneUids, undefined);
    assert.equal((forB.state.units["b-1"].metadata as any).rosterUid, "uid-b1", "own units keep theirs");
    assert.equal((step.state.units["a-1"].metadata as any).rosterUid, "uid-a1", "the session state is untouched");
    assert.equal(forA.turnDeadlineUnix, 123);
  });
});
