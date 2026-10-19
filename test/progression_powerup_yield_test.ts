import assert from "node:assert/strict";

import { MonsterProgression } from "../src/modules/progression/progression.rules";

const progression = new MonsterProgression({
  starTiers: () => [
    { stars: 1, maxLevel: 15, expPerLevel: Array(14).fill(100) },
    { stars: 2, maxLevel: 20, expPerLevel: Array(19).fill(200) },
  ],
  powerUp: () => ({
    currencyId: "GO",
    costPerFodderStarUnit: 600,
    expMultiplierByStars: [{ stars: 1, factor: 0.5, baseExp: 300 }, { stars: 2, factor: 1 }],
    minFodderBaseLevel: 2,
  }),
  evolve: () => ({ currencyId: "GO", costPerStarUnit: 0, steps: [] }),
});

describe("MonsterProgression.powerUpExpYield", () => {
  it("adds the tier's flat base EXP to the accumulated EXP x factor", () => {
    // Lv.1 counts as Lv.2 (100 accumulated) x 0.5 + 300 flat.
    assert.equal(progression.powerUpExpYield(1, 1), 350);
    // Lv.5: 400 accumulated x 0.5 + 300.
    assert.equal(progression.powerUpExpYield(1, 5), 500);
  });

  it("gives no flat EXP when the tier has no base", () => {
    assert.equal(progression.powerUpExpYield(2, 1), 200);
  });
});
