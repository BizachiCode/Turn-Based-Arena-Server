import type { UnitRewardDto } from "../battle-pve/battle-rewards.service.js";

/** Production state of a placed producing building (`sinceUnix` 0 and no units when the player never touched it). */
export type HomeProductionStateDto = {
  sinceUnix: number;
  /** Stationed roster uids (unit EXP producers); may contain uids that no longer exist. */
  units: string[];
};

export type HomePlacementDto = {
  instanceId: string;
  templateInstanceId: string | null;
  buildableId: string;
  x: number;
  z: number;
  yawDegrees: number;
  isTemplateObject: boolean;
  /** Only on placements of producing buildables. */
  production?: HomeProductionStateDto;
};

export type HomeIslandSnapshotDto = {
  islandId: string;
  /** Unlocked by default or bought with `unlock_island`; locked islands accept no placement. */
  unlocked: boolean;
  placements: HomePlacementDto[];
  removedTemplateInstanceIds: string[];
  revision: number;
};

/** Unplaced buildings the player owns (granted by the shop; consumed by `place_object`). */
export type HomeInventoryEntryDto = {
  buildableId: string;
  count: number;
};

export type HomeSnapshotDto = {
  selectedIslandId: string | null;
  islands: HomeIslandSnapshotDto[];
  inventory: HomeInventoryEntryDto[];
  revision: number;
  serverTimeUnix: number;
};

export type HomeMutationResponseDto = {
  ok: boolean;
  snapshot?: HomeSnapshotDto;
  wallet?: Record<string, number>;
  /** `collect_production`: what a currency producer paid out (`null` for unit EXP producers). */
  collected?: HomeCollectedDto | null;
  /** `collect_production` / `set_production_units`: EXP settled on the stationed monsters. */
  units?: UnitRewardDto[];
  error?: string;
};

export type HomeCollectedDto = {
  currencyId: string;
  amount: number;
};

export type HomeObjectRow = {
  instanceId: string;
  islandId: string;
  definitionId: string;
  templateInstanceId: string | null;
  state: "ACTIVE" | "REMOVED";
  originX: number;
  originZ: number;
  yawDegrees: number;
  isTemplateObject: boolean;
};

/** Persisted production state of one placed building (`user_home_production`). */
export type HomeProductionRow = {
  instanceId: string;
  islandId: string;
  buildableId: string;
  sinceUnix: number;
  units: string[];
};
