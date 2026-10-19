import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import { reloadCharacterCatalog, reloadCharacterCatalogFromFile } from "../src/config/CharacterCatalog";
import { reloadLeaderSkillCatalog, reloadLeaderSkillCatalogFromFile } from "../src/config/LeaderSkillCatalog";
import { reloadMapCatalog, reloadMapCatalogFromFile } from "../src/config/MapCatalog";
import { skillUpRules } from "../src/config/catalog-rules";
import { createBattlePveSession } from "../src/modules/battle-pve/BattlePveSessionFactory";
import type { CharacterDto } from "../src/modules/roster/roster.dto";

const stats = { hp: 1000, atk: 100, def: 100, spd: 100, sh: 0, cr: 0.15, cd: 1.5, res: 0.15, acc: 0, eva: 0 };
const skills = [{ id: "strike", targeting: "SingleEnemy", effects: [{ type: "Damage" }] }];

function character(id: string, extra: Record<string, unknown> = {}) {
  return { id, naturalStars: 1, baseStats: stats, starOverrides: [], skillIds: ["strike"], skills, ...extra };
}

function owned(uid: string, characterId: string): CharacterDto {
  return { uid, characterId, stars: 1, level: 1, exp: 0, awakeningIndex: 0, skillLevels: [], locked: false, inStorage: false } as unknown as CharacterDto;
}

describe("BattlePveSessionFactory", () => {
  let dir = "";

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-factory-"));
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };

    await reloadCharacterCatalogFromFile(write("characters.json", {
      characters: [
        character("leader", { leaderSkillId: "curse" }),
        character("support", {
          passives: [{ id: "frost", triggers: [], auras: [{ stat: "Speed", percent: -0.1, flat: 0, scope: "AllEnemies" }] }],
        }),
        character("enemy", { leaderSkillId: "enemy_war_cry" }),
        character("awakened", {
          skills: [...skills, { id: "strike_awakened", maxSkillLevel: 4, effects: [{ type: "Damage" }] }],
          awakenings: [{ index: 1, rewards: { replaceSkills: [{ from: "strike", to: "strike_awakened" }] } }],
        }),
      ],
    }));
    await reloadLeaderSkillCatalogFromFile(write("leader_skills.json", {
      leaderSkills: [
        { id: "curse", scope: "AllEnemies", percentBonuses: { def: -0.2 } },
        { id: "enemy_war_cry", scope: "AllUnits", percentBonuses: { atk: 0.5 } },
      ],
    }));
    await reloadMapCatalogFromFile(write("maps.json", {
      regions: [{
        id: "r1",
        stages: [{
          id: "s1",
          turnLimit: 30,
          formation: { front: 1, back: 2 },
          waves: [
            { enemies: [{ characterId: "enemy", isLeader: true }] },
            { enemies: [{ characterId: "enemy" }] },
          ],
        }],
      }],
    }));
  });

  after(() => {
    reloadCharacterCatalog();
    reloadLeaderSkillCatalog();
    reloadMapCatalog();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function create(seed?: number) {
    return createBattlePveSession(
      { userId: "u1", regionId: "r1", stageId: "s1", difficulty: "Easy", uidsInSlots: ["", "a", "b"], leaderSlotIndex: 1, ...(seed ? { seed } : {}) },
      {
        loadRoster: async (_userId, uids) => [owned("a", "leader"), owned("b", "support")].filter((c) => uids.includes(c.uid)),
        loadEquippedRunes: async () => [],
      },
    );
  }

  it("keeps slot indexes, derives rows from the formation and picks the leader by slot", async () => {
    const state = (await create()).getState();
    const a = state.units["player-1"];
    const b = state.units["player-2"];
    assert.strictEqual(a.metadata?.slotIndex, 1);
    assert.strictEqual(a.metadata?.row, "Backline");
    assert.strictEqual(b.metadata?.slotIndex, 2);
    assert.strictEqual(a.isLeader, true);
    assert.strictEqual(state.metadata.turnLimit, 30);
  });

  it("applies AllEnemies / AllUnits bonuses to the opposing side", async () => {
    const session = await create();
    assert.strictEqual(Object.values(session.getState().units).find((unit) => unit.sideId === "enemies")!.stats.spd, 100,
      "passive auras are not baked into the created stats");
    const state = session.start().state;
    const enemy = Object.values(state.units).find((unit) => unit.sideId === "enemies")!;
    const player = state.units["player-1"];

    assert.strictEqual(enemy.stats.def, 80, "player leader skill (-20% DEF) reaches the enemies");
    assert.strictEqual(enemy.stats.spd, 90, "player passive aura (-10% SPD) reaches the enemies");
    assert.strictEqual(enemy.stats.atk, 150, "enemy AllUnits leader skill applies to its own side");
    assert.strictEqual(player.stats.atk, 150, "enemy AllUnits leader skill reaches the players");
    assert.strictEqual(player.stats.def, 100, "the player's AllEnemies leader skill does not affect its own side");
  });

  it("puts an awakening replacement in the replaced slot with the slot's skill level", async () => {
    const awakened = { ...owned("c", "awakened"), awakeningIndex: 1, skillLevels: [3] } as CharacterDto;
    const session = await createBattlePveSession(
      { userId: "u1", regionId: "r1", stageId: "s1", difficulty: "Easy", uidsInSlots: ["c"], leaderSlotIndex: 0 },
      { loadRoster: async () => [awakened], loadEquippedRunes: async () => [] },
    );
    const unit = session.getState().units["player-1"];
    assert.deepStrictEqual(unit.skills.map((skill) => skill.id), ["strike_awakened"]);
    assert.strictEqual(unit.skillLevels.strike_awakened, 3);
    assert.deepStrictEqual(skillUpRules.skills("awakened", 1), [{ id: "strike_awakened", maxLevel: 4 }]);
    assert.deepStrictEqual(skillUpRules.skills("awakened", 0), [{ id: "strike", maxLevel: 1 }]);
  });

  it("uses a random seed per battle unless one is given", async () => {
    const first = (await create()).getState().metadata.seed;
    const second = (await create()).getState().metadata.seed;
    assert.notStrictEqual(first, second);
    assert.strictEqual((await create(12345)).getState().metadata.seed, 12345);
  });
});
