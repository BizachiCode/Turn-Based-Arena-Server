import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";

import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";
import { reloadRuneCatalogFromDir } from "../src/config/RuneCatalog";
import { computeCharacterStats } from "../src/modules/progression/character-stat-calculator";
import { applyAdditionalBattleStatBonuses, buildPlayerBattleStats } from "../src/modules/battle-core";
import type { RuneDto } from "../src/modules/rune/rune.dto";

function makeCharacter(): CharacterDTO {
  return {
    id: "build-test-character",
    element: "neutral_element",
    naturalStars: 3,
    baseStats: {
      hp: 1000,
      atk: 100,
      def: 80,
      spd: 100,
      sh: 0,
      cr: 0.15,
      cd: 1.5,
      res: 0.15,
      acc: 0.1,
      eva: 0.05,
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

async function loadRuneCatalogFixture() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "battle-runes-"));
  const runeDir = path.join(tempDir, "runes");
  await fs.mkdir(runeDir, { recursive: true });

  await fs.writeFile(path.join(runeDir, "rune_sets.json"), JSON.stringify([
    {
      id: "Energy",
      requiredCount: 2,
      scope: "SelfOnly",
      percentBonuses: {
        MaxHP: 0.15,
      },
      specialEffects: [
        { type: "StartOfBattleImmunityTurns", valueA: 1 },
      ],
    },
  ]), "utf8");
  await fs.writeFile(path.join(runeDir, "rune_slot_rules.json"), "[]", "utf8");
  await fs.writeFile(path.join(runeDir, "rune_main_curves.json"), "[]", "utf8");
  await fs.writeFile(path.join(runeDir, "rune_substat_rolls.json"), "[]", "utf8");
  await fs.writeFile(path.join(runeDir, "rune_grinds.json"), "[]", "utf8");
  await fs.writeFile(path.join(runeDir, "rune_config.json"), JSON.stringify({
    maxLevel: 15,
    upgradeBreakpoints: [3, 6, 9, 12],
    initialSubstatsByQuality: [0, 1, 2, 3, 4],
    onlyCraftedAcceptGemsAndGrinds: true,
    gemEligibleSubstats: [],
    upgradeSuccessPercentByLevel: [],
    upgradeCostByLevel: [],
    costCurrencyId: "GO",
    runesCanBreakOnUpgrade: false,
  }), "utf8");

  await reloadRuneCatalogFromDir(tempDir);
}

describe("Battle player build stats", () => {
  it("keeps client-aligned default speed growth and crit damage baseline", () => {
    const result = computeCharacterStats(makeCharacter(), 3, 10, 0);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.stats.spd, 100);
    assert.equal(result.stats.cd, 1.5);
  });

  it("applies equipped rune stats and completed set bonuses to player battle stats", async () => {
    await loadRuneCatalogFixture();

    const runes: RuneDto[] = [
      {
        uid: "rune-1",
        setId: "Energy",
        slot: 1,
        tier: 6,
        variant: "Normal",
        quality: 4,
        level: 15,
        mainStatType: "HPFlat",
        mainStatValue: 100,
        substats: [],
        origin: "Drop",
        locked: false,
        favorite: false,
        equippedToUid: "char-1",
        equippedAt: null,
        createdAtIso: null,
      },
      {
        uid: "rune-2",
        setId: "Energy",
        slot: 2,
        tier: 6,
        variant: "Normal",
        quality: 4,
        level: 15,
        mainStatType: "SPD",
        mainStatValue: 20,
        substats: [
          { stat: "ATKPercent", value: 10 },
          { stat: "CritRatePercent", value: 5 },
          { stat: "CritDamagePercent", value: 20 },
        ],
        origin: "Drop",
        locked: false,
        favorite: false,
        equippedToUid: "char-1",
        equippedAt: null,
        createdAtIso: null,
      },
    ];

    const result = buildPlayerBattleStats({
      character: makeCharacter(),
      star: 3,
      level: 1,
      awakeningIndex: 0,
      equippedRunes: runes,
    });

    assert.equal(result.baseStats.hp, 1000);
    assert.equal(result.finalStats.hp, 1250);
    assert.equal(result.finalStats.atk, 110);
    assert.equal(result.finalStats.spd, 120);
    assert.equal(result.finalStats.cr, 0.2);
    assert.equal(result.finalStats.cd, 1.7);
    assert.equal(result.completedSets.length, 1);
    assert.equal(result.completedSets[0].setId, "Energy");
    assert.equal(result.setEffects.startOfBattleImmunityTurns, 1);
    assert.equal(result.teamAuraBonuses.atk, 0);
  });

  it("separates team aura set bonuses so they can be redistributed to the whole party", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "battle-runes-team-"));
    const runeDir = path.join(tempDir, "runes");
    await fs.mkdir(runeDir, { recursive: true });

    await fs.writeFile(path.join(runeDir, "rune_sets.json"), JSON.stringify([
      {
        id: "Fight",
        requiredCount: 2,
        scope: "EntireTeam",
        percentBonuses: {
          Attack: 0.1,
        },
        specialEffects: [
          { type: "StartOfBattleImmunityTurns", valueA: 1 },
        ],
      },
    ]), "utf8");
    await fs.writeFile(path.join(runeDir, "rune_slot_rules.json"), "[]", "utf8");
    await fs.writeFile(path.join(runeDir, "rune_main_curves.json"), "[]", "utf8");
    await fs.writeFile(path.join(runeDir, "rune_substat_rolls.json"), "[]", "utf8");
    await fs.writeFile(path.join(runeDir, "rune_grinds.json"), "[]", "utf8");
    await fs.writeFile(path.join(runeDir, "rune_config.json"), JSON.stringify({
      maxLevel: 15,
      upgradeBreakpoints: [3, 6, 9, 12],
      initialSubstatsByQuality: [0, 1, 2, 3, 4],
      onlyCraftedAcceptGemsAndGrinds: true,
      gemEligibleSubstats: [],
      upgradeSuccessPercentByLevel: [],
      upgradeCostByLevel: [],
      costCurrencyId: "GO",
      runesCanBreakOnUpgrade: false,
    }), "utf8");

    await reloadRuneCatalogFromDir(tempDir);

    const result = buildPlayerBattleStats({
      character: makeCharacter(),
      star: 3,
      level: 1,
      awakeningIndex: 0,
      equippedRunes: [
        {
          uid: "fight-1",
          setId: "Fight",
          slot: 1,
          tier: 6,
          variant: "Normal",
          quality: 4,
          level: 15,
          mainStatType: "HPFlat",
          mainStatValue: 0,
          substats: [],
          origin: "Drop",
          locked: false,
          favorite: false,
          equippedToUid: "char-1",
          equippedAt: null,
          createdAtIso: null,
        },
        {
          uid: "fight-2",
          setId: "Fight",
          slot: 2,
          tier: 6,
          variant: "Normal",
          quality: 4,
          level: 15,
          mainStatType: "SPD",
          mainStatValue: 0,
          substats: [],
          origin: "Drop",
          locked: false,
          favorite: false,
          equippedToUid: "char-1",
          equippedAt: null,
          createdAtIso: null,
        },
      ],
    });

    assert.equal(result.finalStats.atk, 100);
    assert.equal(result.teamAuraBonuses.atk, 0.1);
    assert.equal(result.teamAuraSetEffects.startOfBattleImmunityTurns, 1);

    const partyAdjusted = applyAdditionalBattleStatBonuses(result.baseStats, result.finalStats, result.teamAuraBonuses);
    assert.equal(partyAdjusted.atk, 110);
  });
});
