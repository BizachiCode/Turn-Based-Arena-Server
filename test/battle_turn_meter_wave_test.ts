import assert from "node:assert/strict";

import {
  AttackBarTurnOrder,
  PveBattleRuleset,
  createBattleState,
  createBattleUnitState,
  resolveCombatFormula,
} from "../src/modules/battle-core";
import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";

function makeCharacter(params: {
  id: string;
  hp?: number;
  atk?: number;
  def?: number;
  spd?: number;
}): CharacterDTO {
  return {
    id: params.id,
    element: "neutral_element",
    naturalStars: 3,
    baseStats: {
      hp: params.hp ?? 1000,
      atk: params.atk ?? 120,
      def: params.def ?? 80,
      spd: params.spd ?? 100,
      sh: 0,
      cr: 0.15,
      cd: 1.5,
      res: 0.15,
      acc: 0.15,
      eva: 0.1,
    },
    starOverrides: [],
    skillIds: ["idle"],
    passiveIds: [],
    skills: [
      {
        id: "idle",
        maxSkillLevel: 1,
        cooldownByLevel: [0],
        effects: [],
      },
    ],
    awakenings: [],
  };
}

describe("Battle-core turn meter and pve wave rules", () => {
  it("advances turn bars until the next actor is ready", () => {
    const slow = makeCharacter({ id: "slow", spd: 100 });
    const fast = makeCharacter({ id: "fast", spd: 200 });

    const state = createBattleState({
      battleId: "turn-meter-1",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        { unitId: "slow-1", sideId: "players", character: slow, turnBar: 900 },
        { unitId: "fast-1", sideId: "enemies", character: fast, turnBar: 600 },
      ],
      teams: [
        { sideId: "players", isPlayerControlled: true },
        { sideId: "enemies", isPlayerControlled: false },
      ],
    });

    const turnOrder = new AttackBarTurnOrder();
    const events = turnOrder.advance(state, resolveCombatFormula(null));
    assert.equal(events.length, 2);
    assert.equal(state.units["slow-1"].turnBar, 1000);
    assert.equal(state.units["fast-1"].turnBar, 800);
    assert.equal(turnOrder.selectNextActor(state)?.unitId, "slow-1");
  });

  it("uses stats overrides for battle-spawned enemies and keeps pve open for pending waves", () => {
    const hero = makeCharacter({ id: "hero" });
    const enemy = makeCharacter({ id: "enemy" });

    const overriddenEnemy = createBattleUnitState({
      unitId: "enemy-wave-2",
      sideId: "enemies",
      character: enemy,
      statsOverride: {
        hp: 4321,
        atk: 222,
        def: 150,
        spd: 90,
        sh: 75,
        cr: 0.1,
        cd: 1.5,
        res: 0.25,
        acc: 0.2,
        eva: 0.05,
      },
    });

    assert.equal(overriddenEnemy.maxHp, 4321);
    assert.equal(overriddenEnemy.currentHp, 4321);
    assert.equal(overriddenEnemy.shield, 75);

    const state = createBattleState({
      battleId: "pve-wave-1",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        { unitId: "hero-1", sideId: "players", character: hero },
        { unitId: "enemy-1", sideId: "enemies", character: enemy },
      ],
      teams: [
        { sideId: "players", isPlayerControlled: true },
        { sideId: "enemies", isPlayerControlled: false },
      ],
      metadata: {
        playerSideId: "players",
        enemySideId: "enemies",
        pendingEnemyWaveCount: 1,
      },
    });

    state.units["enemy-1"].currentHp = 0;

    const ruleset = new PveBattleRuleset();
    const pendingWaveResolution = ruleset.resolveBattle(state);
    assert.equal(pendingWaveResolution.finished, false);

    state.metadata.pendingEnemyWaveCount = 0;
    const finalResolution = ruleset.resolveBattle(state);
    assert.equal(finalResolution.finished, true);
    assert.equal(finalResolution.winnerSideId, "players");
  });
});
