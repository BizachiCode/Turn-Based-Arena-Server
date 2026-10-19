import assert from "assert";

import type { CharacterDTO, StatsDTO } from "../src/config/DTO/characterCatalogDto";
import { computeCharacterStats } from "../src/modules/progression/character-stat-calculator";

const ZERO: StatsDTO = { hp: 0, atk: 0, def: 0, spd: 0, sh: 0, cr: 0, cd: 0, res: 0, acc: 0, eva: 0 };
const ZERO_GROWTH = { hp: 0, atk: 0, def: 0, spd: 0, cr: 0, cd: 0, res: 0, acc: 0, eva: 0 };
const ONE = { hp: 1, atk: 1, def: 1, spd: 1, sh: 1, cr: 1, cd: 1, res: 1, acc: 1, eva: 1 };
const stats = (patch: Partial<StatsDTO>): StatsDTO => ({ ...ZERO, ...patch });

function makeCharacter(): CharacterDTO {
  return {
    id: "hero",
    naturalStars: 1,
    baseStats: stats({ hp: 1000, atk: 200, def: 100, spd: 100, cr: 0.15, cd: 1.5, res: 0.15 }),
    starOverrides: [{ star: 1, baseMul: { ...ONE, hp: 3 }, perLevel: { ...ZERO_GROWTH, hp: 0.03, atk: 0.03, def: 0.03 } }],
    useManualStarLevelStats: true,
    manualStarLevelStats: [
      { star: 1, levels: [stats({ hp: 900, atk: 90, cd: 1.5 }), stats({ hp: 950, atk: 95, cd: 1.5, cr: 1.4 })] },
    ],
    awakenings: [
      {
        index: 1,
        minLevel: 1,
        minStars: 1,
        costs: [],
        tuning: {
          starOverrides: [],
          flatBonus: stats({ atk: 10 }),
          perLevelBonus: ZERO_GROWTH,
          useCustomBaseStats: true,
          baseStats: stats({ hp: 2000, atk: 300, def: 150, spd: 110, cr: 0.2, cd: 1.5, res: 0.2 }),
          useManualStarLevelStats: true,
          manualStarLevelStats: [{ star: 2, levels: [stats({ hp: 5000, atk: 500, cd: 1.6 })] }],
        },
        rewards: { extraFlatBonus: stats({ hp: 5 }) },
      },
    ],
  };
}

function compute(star: number, level: number, awakening: number): StatsDTO {
  const result = computeCharacterStats(makeCharacter(), star, level, awakening);
  assert.ok(result.ok);
  return result.stats;
}

describe("Character stat formula (Unity GetStatsFor parity)", () => {
  it("uses the character manual table for the levels it covers and clamps chances", () => {
    const lv2 = compute(1, 2, 0);
    assert.strictEqual(lv2.hp, 950);
    assert.strictEqual(lv2.atk, 95);
    assert.strictEqual(lv2.cr, 1);

    // Level 5 is not covered by the table: formula with the star 1 override (hp x3, +3%/level).
    const lv5 = compute(1, 5, 0);
    assert.strictEqual(lv5.hp, Math.round(3000 * 1.12));
    assert.strictEqual(lv5.atk, Math.round(200 * 1.12));
  });

  it("grows a custom-base awakening from its own base stats and adds the flat bonuses", () => {
    const awakened = compute(1, 10, 1);
    // Custom base ignores the character's star override: default x1 and +3%/level, then flat bonuses.
    assert.strictEqual(awakened.hp, 2540 + 5);
    assert.strictEqual(awakened.atk, 381 + 10);
    assert.strictEqual(awakened.spd, 110);
    assert.strictEqual(awakened.cr, 0.2);
  });

  it("prefers the awakening manual table, still adding the awakening bonuses", () => {
    const manual = compute(2, 1, 1);
    assert.strictEqual(manual.hp, 5000 + 5);
    assert.strictEqual(manual.atk, 500 + 10);
    assert.strictEqual(manual.cd, 1.6);
  });

  it("clamps the level to the star's max level", () => {
    assert.deepStrictEqual(compute(1, 99, 1), compute(1, 20, 1));
  });
});
