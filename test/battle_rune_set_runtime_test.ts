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

function makeCharacter(params: {
  id: string;
  skillId: string;
  effect: CharacterDTO["skills"][number]["effects"][number];
  hp?: number;
  atk?: number;
  def?: number;
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
      cr: 0,
      cd: 1.5,
      res: 0.15,
      acc: params.acc ?? 1,
      eva: params.eva ?? 0,
    },
    starOverrides: [],
    skillIds: [params.skillId],
    passiveIds: [],
    skills: [
      {
        id: params.skillId,
        maxSkillLevel: 1,
        cooldownByLevel: [0],
        effects: [params.effect],
      },
    ],
    awakenings: [],
  };
}

async function loadFormulaConfig(values: Record<string, unknown>) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "combat-rune-runtime-"));
  const filePath = path.join(tempDir, "combat_config.json");
  await fs.writeFile(filePath, JSON.stringify(values), "utf8");
  await reloadCombatFormulaCatalogFromFile(filePath);
}

describe("Battle rune set runtime", () => {
  it("applies start-of-battle immunity from unit rune metadata", () => {
    const idleEffect = {
      type: "Damage" as const,
      applyEverySplit: false,
      damageTerms: [],
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

    const state = createBattleState({
      battleId: "rune-start-battle",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        {
          unitId: "hero-1",
          sideId: "players",
          character: makeCharacter({ id: "hero", skillId: "idle", effect: idleEffect }),
          metadata: {
            runeSetEffects: {
              startOfBattleImmunityTurns: 1,
            },
          },
        },
        {
          unitId: "enemy-1",
          sideId: "enemies",
          character: makeCharacter({ id: "enemy", skillId: "idle", effect: idleEffect }),
        },
      ],
    });

    const engine = createServerBattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(101),
    });

    const started = engine.start(state);

    assert.equal(started.accepted, true);
    assert.equal(hasStatus(started.state.units["hero-1"], "Immunity"), true);
    assert.equal(
      started.events.some((event) => event.type === "status_applied" && event.targetId === "hero-1" && event.status === "Immunity"),
      true
    );
  });

  it("applies stun-on-hit and lifesteal from rune metadata after skill resolution", async () => {
    await loadFormulaConfig({
      version: "test-rune-runtime",
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

    const damageEffect = {
      type: "Damage" as const,
      applyEverySplit: false,
      damageTerms: [{ source: "Attack" as const, multiplier: 1 }],
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

    const state = createBattleState({
      battleId: "rune-skill-runtime",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        {
          unitId: "attacker-1",
          sideId: "players",
          character: makeCharacter({ id: "attacker", skillId: "strike", effect: damageEffect }),
          turnBar: 1000,
          metadata: {
            runeSetEffects: {
              stunOnHitChance: 1,
              lifestealPercent: 0.5,
            },
          },
        },
        {
          unitId: "defender-1",
          sideId: "enemies",
          character: makeCharacter({ id: "defender", skillId: "idle", effect: damageEffect }),
        },
      ],
    });
    state.units["attacker-1"].currentHp = 400;

    const engine = createTestEngine({ rng: 202, formulas: makeFormulas({ damage: { glancingDamageMultiplier: 1 } }) });

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

    const damageEvent = resolved.events.find((event) => event.type === "damage_applied");
    assert.ok(damageEvent && damageEvent.type === "damage_applied");
    assert.equal(resolved.state.units["attacker-1"].currentHp, 400 + Math.round(damageEvent.amount * 0.5));
    assert.equal(hasStatus(resolved.state.units["defender-1"], "Stun"), true);
    assert.equal(
      resolved.events.some((event) => event.type === "heal_applied" && event.targetId === "attacker-1"),
      true
    );
  });

  it("grants an extra turn after completing an action", async () => {
    await loadFormulaConfig({
      version: "test-rune-extra-turn",
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

    const damageEffect = {
      type: "Damage" as const,
      applyEverySplit: false,
      damageTerms: [{ source: "Attack" as const, multiplier: 1 }],
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

    const state = createBattleState({
      battleId: "rune-extra-turn",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        {
          unitId: "attacker-1",
          sideId: "players",
          character: makeCharacter({ id: "attacker", skillId: "strike", effect: damageEffect }),
          turnBar: 1000,
          metadata: {
            runeSetEffects: {
              extraTurnChance: 1,
            },
          },
        },
        {
          unitId: "defender-1",
          sideId: "enemies",
          character: makeCharacter({ id: "defender", skillId: "idle", effect: damageEffect }),
        },
      ],
    });

    const engine = createServerBattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(303),
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

    assert.equal(resolved.state.units["attacker-1"].turnBar, resolved.state.units["attacker-1"].turnThreshold);
    assert.equal(
      resolved.events.some((event) => event.type === "extra_turn_granted" && event.actorId === "attacker-1"),
      true
    );
  });

  it("applies nemesis turn bar, destroy max hp and counterattack on the damaged defender", async () => {
    await loadFormulaConfig({
      version: "test-rune-reactive",
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

    const damageEffect = {
      type: "Damage" as const,
      applyEverySplit: false,
      damageTerms: [{ source: "Attack" as const, multiplier: 1 }],
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

    const state = createBattleState({
      battleId: "rune-reactive",
      mode: "pve",
      rulesetId: "pve-default",
      units: [
        {
          unitId: "attacker-1",
          sideId: "players",
          character: makeCharacter({ id: "attacker", skillId: "strike", effect: damageEffect }),
          turnBar: 1000,
          metadata: {
            runeSetEffects: {
              destroyMaxHpPercentPerHit: 0.5,
            },
          },
        },
        {
          unitId: "defender-1",
          sideId: "enemies",
          character: makeCharacter({ id: "defender", skillId: "counter", effect: damageEffect }),
          metadata: {
            runeSetEffects: {
              atbGainPerHpLostPercent: 1,
              counterattackChance: 1,
            },
          },
        },
      ],
    });

    const engine = createServerBattleEngine(new PveBattleRuleset(), {
      rng: new SeededBattleRandom(404),
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

    const firstDamage = resolved.events.find((event) => event.type === "damage_applied" && event.targetId === "defender-1");
    assert.ok(firstDamage && firstDamage.type === "damage_applied");
    assert.equal(
      resolved.state.units["defender-1"].turnBar,
      Math.round((firstDamage.amount / 1000) * resolved.state.units["defender-1"].turnThreshold * 1000) / 1000
    );
    assert.equal(resolved.state.units["defender-1"].maxHp, 1000 - Math.round(firstDamage.amount * 0.5));
    assert.equal(
      resolved.events.some((event) => event.type === "max_hp_changed" && event.targetId === "defender-1"),
      true
    );
    assert.equal(
      resolved.events.some((event) => event.type === "counterattack_triggered" && event.actorId === "defender-1"),
      true
    );
    assert.equal(resolved.state.units["attacker-1"].currentHp, 937);
  });
});
