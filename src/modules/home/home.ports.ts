import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { HomeBuildableCfg, HomeCatalog, HomeFootprintRotationCfg, HomeIslandCfg } from "../../config/HomeCatalog.js";
import type { HomeInventoryEntryDto, HomeObjectRow, HomeProductionRow } from "./home.dto.js";

/** Persistence port for player home deltas (objects placed/moved/removed over the island template). */
export interface HomeRepository {
  listObjects(userId: string, session?: DbSession, forUpdate?: boolean): Promise<HomeObjectRow[]>;
  getPrefs(userId: string, session?: DbSession, forUpdate?: boolean): Promise<{ selectedIslandId: string | null; revision: number }>;
  /** Selects the island and bumps the monotonic home revision. */
  commitMutation(userId: string, islandId: string, session: DbSession): Promise<void>;
  upsertPlayerObject(userId: string, row: Omit<HomeObjectRow, "templateInstanceId" | "state" | "isTemplateObject">, session: DbSession): Promise<void>;
  upsertTemplateState(userId: string, row: HomeObjectRow, session: DbSession): Promise<void>;
  deletePlayerObject(userId: string, instanceId: string, session: DbSession): Promise<void>;
  /** Ids of the islands the player bought (islands unlocked by default are not stored). */
  listUnlockedIslands(userId: string, session?: DbSession, forUpdate?: boolean): Promise<string[]>;
  /**
   * Claims a bought island inside the purchase transaction: true when the row was inserted, false when the player already
   * owns it (also the answer of a concurrent purchase, which waits on the unique key until the first one commits).
   */
  unlockIsland(userId: string, islandId: string, session: DbSession): Promise<boolean>;
}

/** Persistence port for the building inventory (unplaced buildings, e.g. bought in the shop). */
export interface BuildingInventoryRepository {
  /** Entries with at least one unit, ordered by buildable id. */
  list(userId: string, session?: DbSession, forUpdate?: boolean): Promise<HomeInventoryEntryDto[]>;
  /** Adds `count` units (creates the row on first grant). */
  add(userId: string, buildableId: string, count: number, session: DbSession): Promise<void>;
  /** Takes `count` units; false (and no change) when the player owns fewer. */
  consume(userId: string, buildableId: string, count: number, session: DbSession): Promise<boolean>;
}

/** Persistence port for the production state of placed buildings (anchor + stationed units). */
export interface HomeProductionRepository {
  /** All production rows of the player; with `forUpdate` inside a transaction the rows (and the gap) are locked. */
  list(userId: string, session?: DbSession, forUpdate?: boolean): Promise<HomeProductionRow[]>;
  /** Inserts or replaces the row of `row.instanceId`. */
  upsert(userId: string, row: HomeProductionRow, session: DbSession): Promise<void>;
  delete(userId: string, instanceId: string, session: DbSession): Promise<void>;
}

/** Home/island definitions exported from Unity (`homes.json`). */
export interface HomeRules {
  catalog(): HomeCatalog;
  getBuildable(id: string): HomeBuildableCfg | undefined;
  getIsland(id: string): HomeIslandCfg | undefined;
  footprintFor(buildable: HomeBuildableCfg | undefined, yawDegrees: number): HomeFootprintRotationCfg | null;
}

/** Reads the player's account level (unlock requirements). */
export type AccountLevelReader = (userId: string, session?: DbSession) => Promise<number>;
