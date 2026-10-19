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
} from "../src/modules/battle-core";

function makeCharacter(params: {
  id: string;
  skillId: string;
  effect: CharacterDTO["skills"][number]["effects"][number];
  hp?: number;
  atk?: number;
  def?: number;
  cr?: number;
  cd?: number;
  acc?: number;
  eva?: number;
}): CharacterDTO {
  return {
    id: params.id,
    element: "neutral_element",
    naturalStars: 3,
    baseStats: {
      hp: params.hp ?? 1000,
      atk: params.atk ?? 120,
      def: params.def ?? 90,
      spd: 100,
      sh: 0,
      cr: params.cr ?? 0,
      cd: params.cd ?? 1.5,
      res: 0.15,
      acc: params.acc ?? 0.3,
      eva: params.eva ?? 0.1,
    },
    starOverrides: [],
    skillIds: [params.skillId],
    passiveIds: [],
    skills: [
      {
        id: params.skillId,
        maxSkillLevel: 5,
        cooldownByLevel: [0, 0, 0, 0, 0],
        effects: [params.effect],
      },
    ],
    awakenings: [],
  };
}

async function loadFormulaConfig(values: Record<string, unknown>) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "combat-formula-"));
  const filePath = path.join(tempDir, "combat_config.json");
  await fs.writeFile(filePath, JSON.stringify(values), "utf8");
  await reloadCombatFormulaCatalogFromFile(filePath);
}

describe("Battle-core combat formula pipeline", () => {
  it("loads combat config and applies damage through the server engine factory", async () => {
    await loadFormulaConfig({
      version: "test",
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
        glancingDamageMultiplier: 0.7,
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
      effect: {
        type: "Damage",
        applyEverySplit: false,
        damageTerms: [{ source: "Attack", multiplier: 1 }],
        defenseConstant: 100,
        critMultiplier: 1.5,
        flatDamageBonus: 0,
        healFromSource: true,
        healStat: "MaxHP",
        healScale: 0.3,
        flatHealBonus: 0,
        status: "Stun",
        statusDuration: 0,
        statusMagnitude: 0,
        statusPercentPerTurn: 0,
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
    });

    const defender = makeCharacter({
      id: "defender",
      skillId: "idle",
      effect: {
        type: "Damage",
        applyEverySplit: false,
        damageTerms: [],
        defenseConstant: 100,
        critMultiplier: 1.5,
        flatDamageBonus: 0,
        healFromSource: true,
        healStat: "MaxHP",
        healScale: 0.3,
        flatHealBonus: 0,
        status: "Stun",
        statusDuration: 0,
        statusMagnitude: 0,
        statusPercentPerTurn: 0,
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
    });

    const state = createBattleState({
      battleId: "formula-damage",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        { unitId: "attacker-1", sideId: "team-a", character: attacker, turnBar: 1000 },
        { unitId: "defender-1", sideId: "team-b", character: defender },
      ],
    });

    const engine = createServerBattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(11),
    });

    const started = engine.start(state);
    const startedTurn = engine.dispatch(started.state, { type: "start_turn", actorId: "attacker-1" });
    const resolved = engine.dispatch(startedTurn.state, {
      type: "use_skill",
      actorId: "attacker-1",
      skillId: "strike",
      targetId: "defender-1",
    });

    const damageEvent = resolved.events.find((event) => event.type === "damage_applied");
    assert.ok(damageEvent && damageEvent.type === "damage_applied");
    assert.equal(damageEvent.amount, 63);
    assert.equal(resolved.state.units["defender-1"].currentHp, 937);
  });

  it("applies heal and revive using combat config values", async () => {
    await loadFormulaConfig({
      version: "test-heal-revive",
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
        glancingDamageMultiplier: 0.7,
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

    const healer = makeCharacter({
      id: "healer",
      skillId: "heal",
      hp: 1000,
      effect: {
        type: "Heal",
        applyEverySplit: false,
        damageTerms: [],
        defenseConstant: 100,
        critMultiplier: 1.5,
        flatDamageBonus: 0,
        healFromSource: true,
        healStat: "MaxHP",
        healScale: 0.2,
        flatHealBonus: 0,
        status: "Stun",
        statusDuration: 0,
        statusMagnitude: 0,
        statusPercentPerTurn: 0,
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
    });

    const reviver = makeCharacter({
      id: "reviver",
      skillId: "revive",
      effect: {
        type: "Revive",
        applyEverySplit: false,
        damageTerms: [],
        defenseConstant: 100,
        critMultiplier: 1.5,
        flatDamageBonus: 0,
        healFromSource: true,
        healStat: "MaxHP",
        healScale: 0.3,
        flatHealBonus: 0,
        status: "Stun",
        statusDuration: 0,
        statusMagnitude: 0,
        statusPercentPerTurn: 0,
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
    });

    const ally = makeCharacter({
      id: "ally",
      skillId: "idle",
      effect: {
        type: "Damage",
        applyEverySplit: false,
        damageTerms: [],
        defenseConstant: 100,
        critMultiplier: 1.5,
        flatDamageBonus: 0,
        healFromSource: true,
        healStat: "MaxHP",
        healScale: 0.3,
        flatHealBonus: 0,
        status: "Stun",
        statusDuration: 0,
        statusMagnitude: 0,
        statusPercentPerTurn: 0,
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
    });

    const healState = createBattleState({
      battleId: "formula-heal",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        { unitId: "healer-1", sideId: "team-a", character: healer, turnBar: 1000 },
        { unitId: "ally-1", sideId: "team-a", character: ally },
        { unitId: "enemy-anchor-0", sideId: "team-b", character: ally },
      ],
    });
    healState.units["ally-1"].currentHp = 400;

    const engine = createServerBattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(22),
    });

    const healStarted = engine.start(healState);
    const healTurn = engine.dispatch(healStarted.state, { type: "start_turn", actorId: "healer-1" });
    const healResolved = engine.dispatch(healTurn.state, {
      type: "use_skill",
      actorId: "healer-1",
      skillId: "heal",
      targetId: "ally-1",
    });

    const healEvent = healResolved.events.find((event) => event.type === "heal_applied");
    assert.ok(healEvent && healEvent.type === "heal_applied");
    assert.equal(healEvent.amount, 200);
    assert.equal(healResolved.state.units["ally-1"].currentHp, 600);

    const reviveState = createBattleState({
      battleId: "formula-revive",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        { unitId: "reviver-1", sideId: "team-a", character: reviver, turnBar: 1000 },
        { unitId: "dead-ally-1", sideId: "team-a", character: ally },
        { unitId: "enemy-anchor-1", sideId: "team-b", character: ally },
      ],
    });

    reviveState.units["dead-ally-1"].currentHp = 0;
    reviveState.units["dead-ally-1"].statuses.push({
      status: "Stun",
      remainingTurns: 2,
      magnitude: 0,
      percentPerTurn: 0,
      isBuff: false,
      isDispellable: true,
      stacks: 1,
      maxStacks: 1,
      uniqueTag: null,
      sourceId: "enemy-1",
    });

    const reviveStarted = engine.start(reviveState);
    const reviveTurn = engine.dispatch(reviveStarted.state, { type: "start_turn", actorId: "reviver-1" });
    const reviveResolved = engine.dispatch(reviveTurn.state, {
      type: "use_skill",
      actorId: "reviver-1",
      skillId: "revive",
      targetId: "dead-ally-1",
    });

    const reviveEvent = reviveResolved.events.find((event) => event.type === "unit_revived");
    assert.ok(reviveEvent && reviveEvent.type === "unit_revived");
    assert.equal(reviveResolved.state.units["dead-ally-1"].currentHp, 300);
    assert.equal(reviveResolved.state.units["dead-ally-1"].shield, 100);
    assert.equal(reviveResolved.state.units["dead-ally-1"].turnBar, 250);
    assert.equal(reviveResolved.state.units["dead-ally-1"].statuses.length, 0);
  });
});
