import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";

import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";
import { reloadCombatFormulaCatalogFromFile } from "../src/config/CombatFormulaCatalog";
import {
  PveBattleRuleset,
  SeededBattleRandom,
  createBattleState,
  createServerBattleEngine,
  hasStatus,
} from "../src/modules/battle-core";
import { createTestEngine, makeFormulas } from "./helpers/battle-test-kit";

function makeDamageEffect(multiplier: number) {
  return {
    type: "Damage" as const,
    applyEverySplit: false,
    damageTerms: [{ source: "Attack" as const, multiplier }],
    defenseConstant: 100,
    critMultiplier: 1.5,
    flatDamageBonus: 0,
    healFromSource: true,
    healStat: "MaxHP" as const,
    healScale: 0,
    flatHealBonus: 0,
    status: "Stun" as const,
    statusDuration: 0,
    statusMagnitude: 0,
    statusPercentPerTurn: 0,
    applyChance: 1,
    isBuff: false,
    reviveHpPercent: 0.3,
    buffCount: 1,
    baseChance: 1,
    turnBarIncrease: true,
    turnBarAmount: 0,
    cooldownIncrease: true,
    cooldownTurns: 0,
  };
}

function makeCharacter(params: {
  id: string;
  skillId: string;
  effect?: CharacterDTO["skills"][number]["effects"][number];
  hp?: number;
  atk?: number;
  acc?: number;
  passives?: NonNullable<CharacterDTO["passives"]>;
  passiveIds?: string[];
}): CharacterDTO {
  return {
    id: params.id,
    element: "neutral_element",
    naturalStars: 3,
    baseStats: {
      hp: params.hp ?? 1000,
      atk: params.atk ?? 120,
      def: 90,
      spd: 100,
      sh: 0,
      cr: 0,
      cd: 1.5,
      res: 0.15,
      acc: params.acc ?? 1,
      eva: 0,
    },
    starOverrides: [],
    passives: params.passives ?? [],
    skillIds: [params.skillId],
    passiveIds: params.passiveIds ?? [],
    skills: [
      {
        id: params.skillId,
        maxSkillLevel: 1,
        cooldownByLevel: [0],
        effects: params.effect ? [params.effect] : [],
      },
    ],
    awakenings: [],
  };
}

async function loadFormulaConfig(values: Record<string, unknown>) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "combat-passive-runtime-"));
  const filePath = path.join(tempDir, "combat_config.json");
  await fs.writeFile(filePath, JSON.stringify(values), "utf8");
  await reloadCombatFormulaCatalogFromFile(filePath);
}

describe("Battle passive runtime", () => {
  it("applies turn-start and attack passives from embedded character data", async () => {
    await loadFormulaConfig({
      version: "test-passive-runtime",
      timing: { defaultTurnThreshold: 1000, turnBarHeadroomMultiplier: 1.2 },
      accuracy: {
        baseHitChance: 1,
        accuracyVsEvasionWeight: 0,
        minimumHitChance: 1,
        maximumHitChance: 1,
        accuracyVsResistanceWeight: 0,
        minimumDebuffChance: 1,
        maximumDebuffChance: 1,
      },
      damage: {
        minimumDamage: 1,
        defaultDefenseConstant: 100,
        useCriticalDamageStat: false,
        allowCriticalOnGlancing: false,
        glancingChanceOnElementDisadvantage: 0,
        glancingDamageMultiplier: 1,
        elementalAdvantageDamageMultiplier: 1,
        elementalDisadvantageDamageMultiplier: 1,
        elementalNeutralDamageMultiplier: 1,
      },
      healing: { minimumHeal: 1 },
      revive: {
        cleanseDebuffsOnRevive: true,
        shieldPercentOnRevive: 0.1,
        turnBarPercentOnRevive: 0.25,
      },
      elements: { ids: [], matrix: [] },
    });

    const hero = makeCharacter({
      id: "hero",
      skillId: "strike",
      effect: makeDamageEffect(1),
      passives: [
        {
          id: "focus-passive",
          triggers: [
            {
              trigger: "OnTurnStart",
              chance: 1,
              target: "Self",
              effects: [{
                ...makeDamageEffect(0),
                type: "ApplyStatus",
                status: "AttackUp",
                statusDuration: 1,
                isBuff: true,
              }],
            },
            {
              trigger: "OnAttack",
              chance: 1,
              target: "PrimaryTarget",
              effects: [{
                ...makeDamageEffect(0),
                type: "ApplyStatus",
                status: "DefenseBreak",
                statusDuration: 2,
                isBuff: false,
              }],
            },
          ],
        },
      ],
      passiveIds: ["focus-passive"],
    });

    const enemy = makeCharacter({
      id: "enemy",
      skillId: "idle",
      effect: makeDamageEffect(0),
    });

    const state = createBattleState({
      battleId: "passive-turn-attack",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        { unitId: "hero-1", sideId: "players", character: hero, turnBar: 1000 },
        { unitId: "enemy-1", sideId: "enemies", character: enemy },
      ],
    });

    const engine = createTestEngine({ rng: 505, formulas: makeFormulas({ damage: { glancingDamageMultiplier: 1 } }) });

    const started = engine.start(state);
    const turnStarted = engine.dispatch(started.state, {
      type: "start_turn",
      actorId: "hero-1",
    });
    assert.equal(hasStatus(turnStarted.state.units["hero-1"], "AttackUp"), true);
    assert.equal(
      turnStarted.events.some((event) => event.type === "passive_triggered" && event.ownerId === "hero-1" && event.trigger === "OnTurnStart"),
      true
    );

    const resolved = engine.dispatch(turnStarted.state, {
      type: "use_skill",
      actorId: "hero-1",
      skillId: "strike",
      targetId: "enemy-1",
    });

    assert.equal(hasStatus(resolved.state.units["enemy-1"], "DefenseBreak"), true);
    assert.equal(
      resolved.events.some((event) => event.type === "passive_triggered" && event.ownerId === "hero-1" && event.trigger === "OnAttack"),
      true
    );
  });

  it("applies on-death passives (and skips on-damaged for units killed by the hit)", async () => {
    await loadFormulaConfig({
      version: "test-passive-reactive",
      timing: { defaultTurnThreshold: 1000, turnBarHeadroomMultiplier: 1.2 },
      accuracy: {
        baseHitChance: 1,
        accuracyVsEvasionWeight: 0,
        minimumHitChance: 1,
        maximumHitChance: 1,
        accuracyVsResistanceWeight: 0,
        minimumDebuffChance: 1,
        maximumDebuffChance: 1,
      },
      damage: {
        minimumDamage: 1,
        defaultDefenseConstant: 100,
        useCriticalDamageStat: false,
        allowCriticalOnGlancing: false,
        glancingChanceOnElementDisadvantage: 0,
        glancingDamageMultiplier: 1,
        elementalAdvantageDamageMultiplier: 1,
        elementalDisadvantageDamageMultiplier: 1,
        elementalNeutralDamageMultiplier: 1,
      },
      healing: { minimumHeal: 1 },
      revive: {
        cleanseDebuffsOnRevive: true,
        shieldPercentOnRevive: 0.1,
        turnBarPercentOnRevive: 0.25,
      },
      elements: { ids: [], matrix: [] },
    });

    const attacker = makeCharacter({
      id: "attacker",
      skillId: "strike",
      effect: makeDamageEffect(4),
      atk: 150,
    });

    const defender = makeCharacter({
      id: "defender",
      skillId: "idle",
      effect: makeDamageEffect(0),
      hp: 300,
      passives: [
        {
          id: "reactive-passive",
          triggers: [
            {
              trigger: "OnDamaged",
              chance: 1,
              target: "Self",
              effects: [{
                ...makeDamageEffect(0),
                type: "TurnBar",
                turnBarIncrease: true,
                turnBarAmount: 0.5,
              }],
            },
            {
              trigger: "OnDeath",
              chance: 1,
              target: "Self",
              effects: [{
                ...makeDamageEffect(0),
                type: "Revive",
                reviveHpPercent: 0.5,
              }],
            },
          ],
        },
      ],
      passiveIds: ["reactive-passive"],
    });

    const state = createBattleState({
      battleId: "passive-damaged-death",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        { unitId: "attacker-1", sideId: "players", character: attacker, turnBar: 1000 },
        { unitId: "defender-1", sideId: "enemies", character: defender },
      ],
    });

    const engine = createServerBattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(606),
    });

    const started = engine.start(state);
    const turnStarted = engine.dispatch(started.state, {
      type: "start_turn",
      actorId: "attacker-1",
    });
    const resolved = engine.dispatch(turnStarted.state, {
      type: "use_skill",
      actorId: "attacker-1",
      skillId: "strike",
      targetId: "defender-1",
    });

    assert.equal(resolved.state.units["defender-1"].currentHp, 150);
    // The lethal hit kills the defender: OnDamaged does not fire, OnDeath revives it with the revive ATB bonus.
    assert.equal(resolved.state.units["defender-1"].turnBar, 250);
    assert.equal(
      resolved.events.some((event) => event.type === "passive_triggered" && event.ownerId === "defender-1" && event.trigger === "OnDamaged"),
      false
    );
    assert.equal(
      resolved.events.some((event) => event.type === "passive_triggered" && event.ownerId === "defender-1" && event.trigger === "OnDeath"),
      true
    );
  });
});
