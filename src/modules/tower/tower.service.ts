// Towers (Spire of Trials): floors climbed in order once per season. Entry gate of `stage/validateStart`, the
// per-season first clears used by the battle rewards and the `tower/status` query.

import type { TowerCatalog, TowerConfig } from "../../config/TowerCatalog.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { MapRules, StageEntryGate } from "../map/map.ports.js";
import { evaluateTowerGate, nextSeason, seasonKey } from "./tower.domain.js";
import type { TowerStatusResponseDto } from "./tower.dto.js";
import type { SeasonalClear, SeasonalClearRecorder, TowerProgressRepository } from "./tower.ports.js";

export type TowerServiceDeps = {
  config: () => TowerCatalog;
  maps: MapRules;
  progress: TowerProgressRepository;
  /** Account level of a player (1 when the profile is missing). */
  accountLevel: (userId: string) => Promise<number>;
  clock: Clock;
};

export class TowerService implements StageEntryGate, SeasonalClearRecorder {
  constructor(private readonly deps: TowerServiceDeps) {}

  private tower(regionId: string): TowerConfig | undefined {
    return this.deps.config().towers.find((tower) => tower.regionId === regionId);
  }

  private floorIndex(regionId: string, stageId: string): number {
    const region = this.deps.maps.catalog().regions.find((entry) => entry.id === regionId);
    return region ? region.stages.findIndex((stage) => stage.id === stageId) : -1;
  }

  /** Entry gate: null when the region is not a tower or the floor is the next one to climb. */
  async check(userId: string, regionId: string, stageId?: string): Promise<{ code: string; message: string } | null> {
    const tower = this.tower(regionId);
    if (!tower || !stageId) return null;
    const index = this.floorIndex(regionId, stageId);
    if (index < 0) return null;
    const cleared = await this.deps.progress.getCleared(userId, regionId, seasonKey(tower, this.deps.clock.now()));
    return evaluateTowerGate(tower, index, cleared, await this.deps.accountLevel(userId));
  }

  /** Records a won floor inside the reward transaction; the first clear of the next floor advances the season. */
  async recordClear(session: DbSession, userId: string, regionId: string, stageId: string): Promise<SeasonalClear> {
    const tower = this.tower(regionId);
    if (!tower) return { applies: false, firstThisSeason: false };
    const index = this.floorIndex(regionId, stageId);
    const season = seasonKey(tower, this.deps.clock.now());
    const cleared = await this.deps.progress.lockCleared(userId, regionId, season, session);
    if (index !== cleared) return { applies: true, firstThisSeason: false };
    await this.deps.progress.setCleared(userId, regionId, season, cleared + 1, session);
    return { applies: true, firstThisSeason: true };
  }

  async status(userId: string): Promise<TowerStatusResponseDto> {
    const now = this.deps.clock.now();
    const level = await this.deps.accountLevel(userId);
    const regions = this.deps.maps.catalog().regions;
    const towers = this.deps.config().towers.filter((tower) => regions.some((region) => region.id === tower.regionId));

    const keep = new Map(towers.map((tower) => [tower.regionId, seasonKey(tower, now)]));
    await this.deps.progress.deleteOtherSeasons(userId, keep);

    return {
      ok: true,
      serverTimeUnix: Math.floor(now.getTime() / 1000),
      towers: await Promise.all(towers.map(async (tower) => {
        const season = keep.get(tower.regionId)!;
        const next = nextSeason(tower, now);
        return {
          regionId: tower.regionId,
          reset: tower.reset,
          seasonKey: season,
          clearedFloors: await this.deps.progress.getCleared(userId, tower.regionId, season),
          totalFloors: regions.find((region) => region.id === tower.regionId)?.stages.length ?? 0,
          minAccountLevel: tower.minAccountLevel,
          levelLocked: level < tower.minAccountLevel,
          resetsAtUnix: next ? Math.floor(next.getTime() / 1000) : 0,
        };
      })),
    };
  }
}
