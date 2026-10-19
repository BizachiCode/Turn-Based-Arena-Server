// Dungeon halls: entry gate used by the map room (schedule + account level) and the `dungeon/status` query.

import type { DungeonConfig } from "../../config/DungeonCatalog.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { MapRules } from "../map/map.ports.js";
import { evaluateDungeonGate, isHallOpen, nextScheduleChange, type DungeonGateFailure } from "./dungeon.domain.js";
import type { DungeonStatusResponseDto } from "./dungeon.dto.js";

export type DungeonServiceDeps = {
  config: () => DungeonConfig;
  maps: MapRules;
  /** Account level of a player (1 when the profile is missing). */
  accountLevel: (userId: string) => Promise<number>;
  clock: Clock;
};

export class DungeonService {
  constructor(private readonly deps: DungeonServiceDeps) {}

  /** Entry gate for a stage start: null when the region is not a hall or the hall can be entered now. */
  async check(userId: string, regionId: string): Promise<DungeonGateFailure | null> {
    const config = this.deps.config();
    if (!config.halls.some((hall) => hall.regionId === regionId)) return null;
    return evaluateDungeonGate(config, regionId, await this.deps.accountLevel(userId), this.deps.clock.now());
  }

  /** Halls with today's open state (server time) so the client never trusts its own clock. */
  async status(userId: string): Promise<DungeonStatusResponseDto> {
    const config = this.deps.config();
    const now = this.deps.clock.now();
    const level = await this.deps.accountLevel(userId);
    const catalog = this.deps.maps.catalog();

    return {
      ok: true,
      serverTimeUnix: Math.floor(now.getTime() / 1000),
      resetHourUtc: config.resetHourUtc,
      nextResetAtUnix: Math.floor(nextScheduleChange(now, config.resetHourUtc).getTime() / 1000),
      halls: config.halls
        .filter((hall) => catalog.regions.some((region) => region.id === hall.regionId))
        .map((hall) => ({
          regionId: hall.regionId,
          kind: hall.kind,
          elementId: hall.elementId,
          openDays: hall.openDays,
          open: isHallOpen(hall, now, config.resetHourUtc),
          minAccountLevel: hall.minAccountLevel,
          levelLocked: level < hall.minAccountLevel,
        })),
    };
  }
}
