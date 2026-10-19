import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";

import { reloadCharacterCatalogFromFile } from "../src/config/CharacterCatalog";
import {
  applyStatus,
  applyStatusSubsystemEffect,
  createBattleStatusState,
  hasStatus,
  stealBuffs,
  tickStatusesEndOfTurn,
  tickStatusesStartOfTurn,
} from "../src/modules/battle-core";
import type { BattleActiveStatus, BattleUnitStats } from "../src/modules/battle-core";

function makeStats(overrides: Partial<BattleUnitStats> = {}): BattleUnitStats {
  return {
    atk: 100,
    def: 100,
    spd: 100,
    cr: 0.15,
    cd: 1.5,
    res: 0.15,
    acc: 0.15,
    eva: 0.15,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<BattleActiveStatus>): BattleActiveStatus {
  return {
    status: "AttackUp",
    remainingTurns: 2,
    magnitude: 0.5,
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

describe("Battle-core status engine", () => {
  it("loads embedded skills from character json and normalizes enums", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "battle-core-"));
    const filePath = path.join(tempDir, "characters.json");

    await fs.writeFile(filePath, JSON.stringify({
      characters: [
        {
          id: "ember",
          naturalStars: 3,
          baseStats: { hp: 1000, atk: 120, def: 80, spd: 100, sh: 0, cr: 0.1, cd: 1.5, res: 0.15, acc: 0.3, eva: 0.1 },
          starOverrides: [],
          skillIds: ["skill_burn"],
          skills: [
            {
              id: "skill_burn",
              maxSkillLevel: 5,
              cooldownByLevel: [3, 3, 2, 2, 1],
              effects: [
                {
                  type: 2,
                  status: "ContinuousDamage",
                  statusDuration: 2,
                  statusPercentPerTurn: 0.08,
                  applyChance: 0.75,
                  isBuff: false
                }
              ]
            }
          ]
        }
      ]
    }), "utf8");

    const catalog = await reloadCharacterCatalogFromFile(filePath);
    const skill = catalog.characters[0].skills?.[0];

    assert.equal(skill?.id, "skill_burn");
    assert.equal(skill?.effects[0].type, "ApplyStatus");
    assert.equal(skill?.effects[0].status, "ContinuousDamage");
    assert.equal(skill?.effects[0].statusPercentPerTurn, 0.08);
    assert.equal(skill?.effects[0].applyChance, 0.75);
  });

  it("blocks debuffs when immunity is active", () => {
    const source = createBattleStatusState({
      unitId: "source",
      stats: makeStats({ acc: 1 }),
      maxHp: 1000,
    });

    const target = createBattleStatusState({
      unitId: "target",
      stats: makeStats({ res: 0 }),
      maxHp: 1000,
      statuses: [
        makeStatus({
          status: "Immunity",
          isBuff: true,
          magnitude: 0,
          remainingTurns: 2,
        }),
      ],
    });

    const result = applyStatus({
      source,
      target,
      status: "Stun",
      duration: 2,
      applyChance: 1,
      isBuff: false,
    }, () => 0);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "IMMUNITY");
    assert.equal(hasStatus(target, "Stun"), false);
  });

  it("ticks continuous damage at turn start without waking sleep and expires the dot at turn end", () => {
    const target = createBattleStatusState({
      unitId: "target",
      stats: makeStats(),
      maxHp: 1000,
      statuses: [
        makeStatus({
          status: "ContinuousDamage",
          isBuff: false,
          remainingTurns: 1,
          magnitude: 0,
          percentPerTurn: 0.1,
        }),
        makeStatus({
          status: "Sleep",
          isBuff: false,
          remainingTurns: 2,
          magnitude: 0,
        }),
      ],
    });

    const startTick = tickStatusesStartOfTurn(target);
    assert.equal(startTick.ok, true);
    assert.equal(target.currentHp, 900);
    assert.equal(hasStatus(target, "Sleep"), true);
    assert.equal(hasStatus(target, "ContinuousDamage"), true);

    const endTick = tickStatusesEndOfTurn(target);
    assert.equal(endTick.ok, true);
    assert.equal(target.currentHp, 900);
    assert.equal(hasStatus(target, "Sleep"), true);
    assert.equal(hasStatus(target, "ContinuousDamage"), false);
  });

  it("steals a buff from target to source", () => {
    const source = createBattleStatusState({
      unitId: "source",
      stats: makeStats(),
      maxHp: 1000,
    });

    const target = createBattleStatusState({
      unitId: "target",
      stats: makeStats(),
      maxHp: 1000,
      statuses: [
        makeStatus({
          status: "AttackUp",
          isBuff: true,
          remainingTurns: 3,
          magnitude: 0.5,
          sourceId: "target",
        }),
      ],
    });

    const result = stealBuffs(source, target, 1, () => 0);

    assert.equal(result.ok, true);
    assert.equal(hasStatus(target, "AttackUp"), false);
    assert.equal(hasStatus(source, "AttackUp"), true);
  });

  it("applies status effects straight from the skill effect payload", () => {
    const source = createBattleStatusState({
      unitId: "source",
      stats: makeStats({ acc: 1 }),
      maxHp: 1000,
    });

    const target = createBattleStatusState({
      unitId: "target",
      stats: makeStats({ res: 0 }),
      maxHp: 1000,
    });

    const result = applyStatusSubsystemEffect({
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
      status: "Stun",
      statusDuration: 2,
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
    }, source, target, undefined, () => 0.5);

    assert.equal(result.ok, true);
    assert.equal(hasStatus(target, "Stun"), true);
  });
});
