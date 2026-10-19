import assert from "node:assert/strict";

import type { MapCatalog, MapStage } from "../src/config/MapCatalog";
import { TowerCatalogSchema, parseTowerCatalog, type TowerCatalog } from "../src/config/TowerCatalog";
import { FixedClock } from "../src/shared/kernel/clock";
import { evaluateStageUnlock } from "../src/modules/map/map.unlock";
import { composeGates } from "../src/modules/map/map.ports";
import { nextSeason, seasonKey } from "../src/modules/tower/tower.domain";
import type { TowerProgressRepository } from "../src/modules/tower/tower.ports";
import { TowerService } from "../src/modules/tower/tower.service";
import { SESSION } from "./support/fakes";

// Monday 2026-10-12 10:00 UTC.
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const USER = "u1";

class InMemoryTowerProgress implements TowerProgressRepository {
  rows = new Map<string, number>();
  async getCleared(userId: string, regionId: string, seasonKey: string) { return this.rows.get(`${userId}|${regionId}|${seasonKey}`) ?? 0; }
  async lockCleared(userId: string, regionId: string, seasonKey: string) { return this.getCleared(userId, regionId, seasonKey); }
  async setCleared(userId: string, regionId: string, seasonKey: string, floors: number) { this.rows.set(`${userId}|${regionId}|${seasonKey}`, floors); }
  async deleteOtherSeasons(userId: string, keep: Map<string, string>) {
    for (const key of [...this.rows.keys()]) {
      const [user, region, season] = key.split("|");
      if (user === userId && keep.has(region) && keep.get(region) !== season) this.rows.delete(key);
    }
  }
}

const floor = (id: string): MapStage => ({ id, currencyId: "EN", costs: [], formation: { front: 2, back: 2, leaderIndex: 0 }, rewards: [] });
const catalog: MapCatalog = {
  regions: [
    { id: "story_1", kind: "story", stageCount: 1, stages: [floor("s1")] },
    { id: "toa", kind: "tower", stageCount: 3, stages: [floor("f1"), floor("f2"), floor("f3")] },
  ],
};

function setup(overrides: Partial<TowerCatalog["towers"][number]> = {}, level = 10) {
  const clock = new FixedClock(NOW);
  const progress = new InMemoryTowerProgress();
  const config: TowerCatalog = TowerCatalogSchema.parse({ towers: [{ regionId: "toa", reset: "monthly", minAccountLevel: 5, ...overrides }] });
  const service = new TowerService({
    config: () => config,
    maps: { catalog: () => catalog, getStage: () => undefined },
    progress,
    accountLevel: async () => level,
    clock,
  });
  return { clock, progress, service };
}

describe("Tower seasons", () => {
  it("keys monthly / weekly / never seasons and finds the next reset", () => {
    const now = new Date(NOW);
    const monthly = { reset: "monthly" as const, resetHourUtc: 0, weekStartsOn: 1 };
    const weekly = { reset: "weekly" as const, resetHourUtc: 0, weekStartsOn: 1 };
    assert.equal(seasonKey(monthly, now), "M:2026-10");
    assert.equal(nextSeason(monthly, now)?.toISOString(), "2026-11-01T00:00:00.000Z");
    assert.equal(seasonKey(weekly, now), "W:2026-10-12");
    assert.equal(nextSeason(weekly, now)?.toISOString(), "2026-10-19T00:00:00.000Z");
    assert.equal(seasonKey({ ...weekly, weekStartsOn: 0 }, now), "W:2026-10-11");
    assert.equal(seasonKey({ ...monthly, resetHourUtc: 12 }, new Date(Date.UTC(2026, 9, 1, 11))), "M:2026-09", "before the reset hour of day 1");
    assert.equal(seasonKey({ reset: "never", resetHourUtc: 0, weekStartsOn: 1 }, now), "all");
  });

  it("parses enum ordinals and rejects duplicate towers", () => {
    assert.equal(parseTowerCatalog(JSON.stringify({ Towers: [{ RegionId: "t", Reset: 1 }] })).towers[0].reset, "weekly");
    assert.throws(() => parseTowerCatalog(JSON.stringify({ towers: [{ regionId: "t" }, { regionId: "t" }] })));
  });
});

describe("Tower service", () => {
  it("climbs floors in order once per season and resets with the season", async () => {
    const { service, clock } = setup();
    assert.equal((await service.check(USER, "toa", "f2"))?.code, "TOWER_FLOOR_LOCKED");
    assert.equal(await service.check(USER, "toa", "f1"), null);
    assert.equal(await service.check(USER, "story_1", "s1"), null, "not a tower");

    assert.deepEqual(await service.recordClear(SESSION, USER, "toa", "f1"), { applies: true, firstThisSeason: true });
    assert.equal((await service.check(USER, "toa", "f1"))?.code, "TOWER_FLOOR_CLEARED");
    assert.equal(await service.check(USER, "toa", "f2"), null);
    assert.deepEqual(await service.recordClear(SESSION, USER, "toa", "f1"), { applies: true, firstThisSeason: false });
    assert.deepEqual(await service.recordClear(SESSION, USER, "story_1", "s1"), { applies: false, firstThisSeason: false });

    const status = await service.status(USER);
    assert.deepEqual(status.towers.map((t) => [t.regionId, t.clearedFloors, t.totalFloors, t.seasonKey]), [["toa", 1, 3, "M:2026-10"]]);
    assert.equal(status.towers[0].resetsAtUnix, Date.UTC(2026, 10, 1) / 1000);

    clock.set(Date.UTC(2026, 10, 2));
    assert.equal(await service.check(USER, "toa", "f1"), null, "new season starts at floor 1");
    assert.equal((await service.status(USER)).towers[0].clearedFloors, 0);
  });

  it("refuses players below the level and composes with other gates", async () => {
    const { service } = setup({}, 3);
    assert.equal((await service.check(USER, "toa", "f1"))?.code, "TOWER_LEVEL_LOCKED");
    const deny = { check: async () => ({ code: "DUNGEON_CLOSED", message: "closed" }) };
    assert.equal((await composeGates(deny, service).check(USER, "toa", "f1"))?.code, "DUNGEON_CLOSED");
    assert.equal((await composeGates({ check: async () => null }, service).check(USER, "toa", "f1"))?.code, "TOWER_LEVEL_LOCKED");
  });

  it("tower regions only have the first difficulty and skip the story chain", () => {
    assert.equal(evaluateStageUnlock(catalog, [], "toa", "f3", "Easy"), null);
    assert.equal(evaluateStageUnlock(catalog, [], "toa", "f1", "Normal")?.code, "DIFFICULTY_LOCKED");
  });

  it("an unfinished tower does not keep the next story difficulty locked", () => {
    const easyStory = [{ regionId: "story_1", stageId: "s1", difficulty: "Easy" as const, clears: 1, bestClearMs: null }];
    assert.equal(evaluateStageUnlock(catalog, easyStory, "story_1", "s1", "Normal"), null);
    assert.equal(evaluateStageUnlock(catalog, [], "story_1", "s1", "Normal")?.code, "DIFFICULTY_LOCKED");
  });
});
