import assert from "node:assert/strict";

import { createSeededRandom, type RandomSource } from "../src/shared/kernel/random";
import { parseMapCatalog, type StageDropTable } from "../src/config/MapCatalog";
import { rollStageDrops } from "../src/modules/battle-pve/stage-drops";

function scripted(floats: number[], ints: number[] = []): RandomSource {
  return { float: () => floats.shift() ?? 0, int: () => ints.shift() ?? 0 };
}

const table: StageDropTable = {
  id: "drops_r3_hard",
  rune: {
    chance: 0.5,
    stars: [{ stars: 3, weight: 60 }, { stars: 4, weight: 30 }, { stars: 5, weight: 10 }],
    grades: [{ grade: 1, weight: 25 }, { grade: 2, weight: 33 }, { grade: 3, weight: 25 }, { grade: 4, weight: 13 }, { grade: 5, weight: 4 }],
    sets: [],
  },
  items: [
    { currencyId: "magic_mid", min: 1, max: 2, chance: 0.1 },
    { currencyId: "GO", min: 500, max: 900, chance: 0.3 },
  ],
};

describe("Stage drop tables", () => {
  it("rolls table items, stage extras, then the rune (stars, grade, set) in a fixed order", () => {
    // items: magic 0.05 < 0.1 (amount +1), GO 0.9 fails; extra 0.0 passes (amount +0);
    // rune 0.4 < 0.5, stars 0.95 → 5★ (cumulative 60/90/100), grade 0.9 → Hero (cumulative 25/58/83/96).
    const random = scripted([0.05, 0.9, 0.0, 0.4, 0.95, 0.9], [1, 0]);
    const drops = rollStageDrops(random, table, [{ currencyId: "fire_low", min: 2, max: 2, chance: 1 }]);
    assert.deepEqual(drops.currencies, [{ currencyId: "magic_mid", amount: 2 }, { currencyId: "fire_low", amount: 2 }]);
    assert.deepEqual(drops.rune, { tier: 5, quality: 4 });
  });

  it("drops no rune when the chance roll fails and picks the set from the table", () => {
    assert.equal(rollStageDrops(scripted([1, 1, 0.6]), table, []).rune, null);
    const crypt: StageDropTable = { ...table, rune: { ...table.rune!, chance: 1, sets: ["Energy", "Swift", "Guard"] }, items: [] };
    assert.deepEqual(rollStageDrops(scripted([0, 0, 0.99], [2]), crypt, []).rune, { tier: 3, quality: 5, setId: "Guard" });
    assert.deepEqual(rollStageDrops(scripted([]), undefined, []), { currencies: [], rune: null }, "no table and no extras");
  });

  it("follows the star and grade weights over many runs", () => {
    const random = createSeededRandom(42);
    const always: StageDropTable = { ...table, rune: { ...table.rune!, chance: 1 }, items: [] };
    const stars = new Map<number, number>();
    const grades = new Map<number, number>();
    const runs = 20_000;
    for (let i = 0; i < runs; i++) {
      const rune = rollStageDrops(random, always, []).rune!;
      stars.set(rune.tier, (stars.get(rune.tier) ?? 0) + 1);
      grades.set(rune.quality, (grades.get(rune.quality) ?? 0) + 1);
    }
    const share = (map: Map<number, number>, key: number) => (map.get(key) ?? 0) / runs;
    assert.ok(Math.abs(share(stars, 3) - 0.6) < 0.02 && Math.abs(share(stars, 5) - 0.1) < 0.015);
    assert.ok(Math.abs(share(grades, 1) - 0.25) < 0.02 && Math.abs(share(grades, 5) - 0.04) < 0.01);
    assert.equal(stars.has(6), false, "never outside the table");
  });

  it("resolves drop table references when parsing maps.json", () => {
    const catalog = parseMapCatalog(JSON.stringify({
      dropTables: [
        { id: "t1", rune: { chance: 2, stars: [{ stars: 9, weight: 5 }, { stars: 2, weight: 3 }, { stars: 2, weight: 1 }], grades: [], sets: ["Energy", "Energy"] },
          items: [{ currencyId: "magic_low", min: 2, max: 1, chance: 0.2 }, { currencyId: "", min: 1, max: 1, chance: 1 }] },
        { id: "no_rune", rune: { chance: 0.5, stars: [] }, items: [] },
      ],
      regions: [{ id: "r1", stages: [{ id: "s1", rewards: [
        { difficulty: "Easy", dropTableId: "t1", randomDrops: [{ currencyId: "fire_low", min: 1, max: 3, chance: 1 }] },
        { difficulty: "Normal", dropTableId: "missing" },
        { difficulty: "Hard", dropTableId: "no_rune" },
      ] }] }],
    }));
    const [easy, normal, hard] = catalog.regions[0].stages[0].rewards!;
    assert.deepEqual(easy.dropTable, {
      id: "t1",
      rune: { chance: 1, stars: [{ stars: 2, weight: 4 }], grades: [{ grade: 1, weight: 1 }], sets: ["Energy"] },
      items: [{ currencyId: "magic_low", min: 2, max: 2, chance: 0.2 }],
    });
    assert.equal(easy.dropTable, catalog.dropTables!.t1, "shared table instance");
    assert.deepEqual(easy.randomDrops, [{ currencyId: "fire_low", min: 1, max: 3, chance: 1 }]);
    assert.equal(normal.dropTable, undefined, "unknown tables are ignored");
    assert.equal(hard.dropTable?.rune, null, "a table without star weights never drops runes");
  });
});
