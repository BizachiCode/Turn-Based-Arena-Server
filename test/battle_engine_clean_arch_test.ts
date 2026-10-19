import assert from "node:assert/strict";

import {
  ArenaBattleRuleset,
  BattleEngine,
  BossBattleRuleset,
  PveBattleRuleset,
  SeededBattleRandom,
  StaticCombatFormulaProvider,
  createBattleState,
  hasStatus,
} from "../src/modules/battle-core";
import { makeFormulas } from "./helpers/battle-test-kit";
import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";

function makeCharacter(params: {
  id: string;
  skillId: string;
  cooldown?: number;
  status?: "Stun" | "ContinuousDamage";
}): CharacterDTO {
  return {
    id: params.id,
    naturalStars: 3,
    baseStats: {
      hp: 1000,
      atk: 120,
      def: 90,
      spd: 100,
      sh: 0,
      cr: 0.1,
      cd: 1.5,
      res: 0.15,
      acc: 0.3,
      eva: 0.1,
    },
    starOverrides: [],
    skillIds: [params.skillId],
    passiveIds: [],
    skills: [
      {
        id: params.skillId,
        maxSkillLevel: 5,
        cooldownByLevel: [params.cooldown ?? 0, params.cooldown ?? 0, params.cooldown ?? 0, params.cooldown ?? 0, params.cooldown ?? 0],
        effects: params.status
          ? [
              {
                type: "ApplyStatus",
                applyEverySplit: false,
                damageTerms: [],
                defenseConstant: 100,
                critMultiplier: 1.5,
                flatDamageBonus: 0,
                healFromSource: true,
                healStat: "MaxHP",
                healScale: 0.3,
                flatHealBonus: 0,
                status: params.status,
                statusDuration: 2,
                statusMagnitude: 0,
                statusPercentPerTurn: params.status === "ContinuousDamage" ? 0.08 : 0,
                applyChance: 1,
                isBuff: false,
                reviveHpPercent: 0.3,
                buffCount: 1,
                baseChance: 1,
                turnBarIncrease: true,
                turnBarAmount: 0.3,
                cooldownIncrease: true,
                cooldownTurns: 1,
              },
            ]
          : [],
      },
    ],
    awakenings: [],
  };
}

describe("Battle-core clean architecture engine", () => {
  it("starts a PVE battle and resolves a skill through the engine", () => {
    const hero = makeCharacter({ id: "hero", skillId: "hero_stun", cooldown: 3, status: "Stun" });
    const enemy = makeCharacter({ id: "enemy", skillId: "enemy_wait", cooldown: 0 });

    const initialState = createBattleState({
      battleId: "battle-pve-1",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        {
          unitId: "player-1",
          sideId: "players",
          character: hero,
          turnBar: 1000,
        },
        {
          unitId: "enemy-1",
          sideId: "enemies",
          character: enemy,
        },
      ],
      teams: [
        { sideId: "players", isPlayerControlled: true },
        { sideId: "enemies", isPlayerControlled: false },
      ],
    });

    const engine = new BattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(123),
      combatFormulaProvider: new StaticCombatFormulaProvider(makeFormulas()),
    });

    const started = engine.start(initialState);
    assert.equal(started.accepted, true);
    assert.equal(started.state.phase, "waiting_for_turn");

    const turnStarted = engine.dispatch(started.state, {
      type: "start_turn",
      actorId: "player-1",
    });

    assert.equal(turnStarted.accepted, true);
    assert.equal(turnStarted.state.phase, "awaiting_action");
    assert.equal(turnStarted.state.actingUnitId, "player-1");

    const usedSkill = engine.dispatch(turnStarted.state, {
      type: "use_skill",
      actorId: "player-1",
      skillId: "hero_stun",
      targetId: "enemy-1",
    });

    assert.equal(usedSkill.accepted, true);
    assert.equal(usedSkill.state.phase, "waiting_for_turn");
    assert.equal(hasStatus(usedSkill.state.units["enemy-1"], "Stun"), true);
    assert.equal(usedSkill.state.units["player-1"].cooldowns["hero_stun"], 2);
    assert.equal(usedSkill.state.units["player-1"].turnBar, 0);
  });

  it("auto-skips a controlled unit on turn start", () => {
    const hero = makeCharacter({ id: "hero", skillId: "hero_wait", cooldown: 0 });
    const enemy = makeCharacter({ id: "enemy", skillId: "enemy_wait", cooldown: 0 });

    const initialState = createBattleState({
      battleId: "battle-pve-cc",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        {
          unitId: "player-1",
          sideId: "players",
          character: hero,
          turnBar: 1000,
        },
        {
          unitId: "enemy-1",
          sideId: "enemies",
          character: enemy,
        },
      ],
    });

    initialState.units["player-1"].statuses.push({
      status: "Stun",
      remainingTurns: 1,
      magnitude: 0,
      percentPerTurn: 0,
      isBuff: false,
      isDispellable: true,
      stacks: 1,
      maxStacks: 1,
      uniqueTag: null,
      sourceId: "enemy-1",
    });

    const engine = new BattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(456),
    });

    const started = engine.start(initialState);
    const skipped = engine.dispatch(started.state, {
      type: "start_turn",
      actorId: "player-1",
    });

    assert.equal(skipped.accepted, true);
    assert.equal(skipped.state.phase, "waiting_for_turn");
    assert.equal(skipped.state.actingUnitId, null);
    assert.equal(hasStatus(skipped.state.units["player-1"], "Stun"), false);
    assert.equal(skipped.events.some((event) => event.type === "turn_skipped"), true);
  });

  it("finishes an arena battle on surrender", () => {
    const hero = makeCharacter({ id: "hero", skillId: "hero_wait", cooldown: 0 });
    const enemy = makeCharacter({ id: "enemy", skillId: "enemy_wait", cooldown: 0 });

    const initialState = createBattleState({
      battleId: "battle-arena-1",
      mode: "arena",
      rulesetId: "arena-default",
      units: [
        {
          unitId: "blue-1",
          sideId: "blue",
          character: hero,
        },
        {
          unitId: "red-1",
          sideId: "red",
          character: enemy,
        },
      ],
    });

    const engine = new BattleEngine(new ArenaBattleRuleset(), {
      rng: new SeededBattleRandom(789),
    });

    const started = engine.start(initialState);
    const surrendered = engine.dispatch(started.state, {
      type: "surrender",
      sideId: "blue",
    });

    assert.equal(surrendered.accepted, true);
    assert.equal(surrendered.state.phase, "finished");
    assert.equal(surrendered.state.winnerSideId, "red");
    assert.equal(surrendered.state.finishedReason, "surrender");
  });

  it("uses boss ruleset turn limit as a mode-specific win condition", () => {
    const challenger = makeCharacter({ id: "challenger", skillId: "challenger_wait", cooldown: 0 });
    const boss = makeCharacter({ id: "boss", skillId: "boss_wait", cooldown: 0 });

    const initialState = createBattleState({
      battleId: "battle-boss-1",
      mode: "boss",
      rulesetId: "boss-default",
      units: [
        {
          unitId: "challenger-1",
          sideId: "challengers",
          character: challenger,
          turnBar: 1000,
        },
        {
          unitId: "boss-1",
          sideId: "bosses",
          character: boss,
          isBoss: true,
        },
      ],
      metadata: {
        bossSideId: "bosses",
        challengerSideId: "challengers",
        turnLimit: 1,
      },
    });

    const engine = new BattleEngine(new BossBattleRuleset(), {
      rng: new SeededBattleRandom(999),
    });

    const started = engine.start(initialState);
    const turnStarted = engine.dispatch(started.state, {
      type: "start_turn",
      actorId: "challenger-1",
    });
    const ended = engine.dispatch(turnStarted.state, {
      type: "end_turn",
      actorId: "challenger-1",
      reason: "manual",
    });

    assert.equal(ended.accepted, true);
    assert.equal(ended.state.phase, "finished");
    assert.equal(ended.state.winnerSideId, "bosses");
    assert.equal(ended.state.finishedReason, "turn_limit");
  });
});
