import { ulid } from "ulid";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { HomeCellFlag, type HomeBuildableCfg, type HomeIslandCfg, type HomeProductionCfg } from "../../config/HomeCatalog.js";
import type { UnitRewardDto } from "../battle-pve/battle-rewards.service.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { MonsterProgression } from "../progression/progression.rules.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { CharacterRecord, CharacterRepository } from "../roster/roster.ports.js";
import type { HomeCollectedDto, HomeIslandSnapshotDto, HomeInventoryEntryDto, HomeMutationResponseDto, HomeObjectRow, HomePlacementDto, HomeProductionRow, HomeSnapshotDto } from "./home.dto.js";
import { isActiveProduction, nextAnchor, storedAt } from "./home-production.js";
import type { AccountLevelReader, BuildingInventoryRepository, HomeProductionRepository, HomeRepository, HomeRules } from "./home.ports.js";

function keyOf(x: number, z: number): string {
  return `${x}:${z}`;
}

function normalizeYaw(buildable: HomeBuildableCfg, yawDegrees: number): number {
  const step = Math.max(1, Number(buildable.rotationStepDegrees || 90));
  const normalized = Math.round((((Number(yawDegrees ?? 0) % 360) + 360) % 360) / step) * step;
  return ((normalized % 360) + 360) % 360;
}

function isBuildableCell(island: HomeIslandCfg, x: number, z: number): boolean {
  const cell = island.cells.find((entry) => entry.x === x && entry.z === z);
  if (!cell) return false;

  const flags = Number(cell.flags ?? 0) | 0;
  const blockedMask = HomeCellFlag.Blocked | HomeCellFlag.Disabled | HomeCellFlag.Reserved | HomeCellFlag.Water;
  return (flags & HomeCellFlag.Buildable) !== 0 && (flags & blockedMask) === 0;
}

type PlaceInput = { islandId: string; definitionId: string; originX: number; originZ: number; yawDegrees: number };
type MoveInput = { islandId: string; instanceId: string; originX: number; originZ: number; yawDegrees: number };
type RemoveInput = { islandId: string; instanceId: string };
type CollectInput = { islandId: string; instanceId: string };
type SetUnitsInput = { islandId: string; instanceId: string; uids: string[] };

/**
 * Home island use cases: snapshot, place (consumes inventory, else buys), move and remove objects, island purchases
 * (`unlockIsland`), production buildings (`collectProduction` / `setProductionUnits`), plus the building inventory used
 * by the shop (`exists` / `ownedCount` / `grant`). Objects can only be placed, moved or removed on unlocked islands.
 */
export class HomeService {
  constructor(
    private readonly homes: HomeRepository,
    private readonly inventory: BuildingInventoryRepository,
    private readonly rules: HomeRules,
    private readonly ledger: WalletLedger,
    private readonly levelOf: AccountLevelReader,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly productions: HomeProductionRepository,
    private readonly characters: CharacterRepository,
    private readonly progression: MonsterProgression,
    private readonly rosterCache: RosterCache,
  ) {}

  async getSnapshot(userId: string): Promise<HomeSnapshotDto> {
    const rows = await this.homes.listObjects(userId);
    const prefs = await this.homes.getPrefs(userId);
    const stock = await this.inventory.list(userId);
    const unlocked = await this.homes.listUnlockedIslands(userId);
    const production = await this.productions.list(userId);
    return this.buildSnapshotFromRows(rows, stock, prefs.selectedIslandId, prefs.revision, unlocked, production);
  }

  /**
   * Buys a locked island. Order (mirrored by the Unity `OfflineHomeService.UnlockIsland`): island exists
   * (`HOME_ISLAND_NOT_FOUND`) → not a default island and not owned yet (`HOME_ISLAND_ALREADY_UNLOCKED`) → account level
   * `unlockLevel` (`HOME_LOCKED`) → the ownership row is claimed → `unlockCost` debited (no currency or zero = free,
   * `ECON_INSUFFICIENT_FUNDS` rolls the claim back). Idempotent: the claim is the unique key `(user, island)`, so a repeated
   * or concurrent purchase answers `HOME_ISLAND_ALREADY_UNLOCKED` and is never charged twice. Answers with the snapshot
   * (the island selected) and the full wallet.
   */
  async unlockIsland(userId: string, islandId: string): Promise<HomeMutationResponseDto> {
    const island = this.rules.getIsland(islandId);
    if (!island) throw new AppError(ErrorCode.HOME_ISLAND_NOT_FOUND);
    if (island.unlockedByDefault) throw new AppError(ErrorCode.HOME_ISLAND_ALREADY_UNLOCKED);

    await this.uow.transaction(async (session) => {
      const owned = await this.homes.listUnlockedIslands(userId, session);
      if (owned.includes(island.id)) throw new AppError(ErrorCode.HOME_ISLAND_ALREADY_UNLOCKED);
      if ((await this.levelOf(userId, session)) < Math.max(0, island.unlockLevel || 0)) throw new AppError(ErrorCode.HOME_LOCKED);

      if (!(await this.homes.unlockIsland(userId, island.id, session))) throw new AppError(ErrorCode.HOME_ISLAND_ALREADY_UNLOCKED);
      await this.spendIfNeeded(session, userId, island.unlockCostCurrencyId, island.unlockCostAmount);
      await this.homes.commitMutation(userId, island.id, session);
    });

    return { ok: true, snapshot: await this.getSnapshot(userId), wallet: await this.ledger.snapshot(userId) };
  }

  /** True when the buildable exists in the home catalog (shop reward validation). */
  exists(buildableId: string): boolean {
    return !!this.rules.getBuildable(buildableId);
  }

  /** Units the player owns: unplaced inventory + placed (island template defaults included). Locks the rows. */
  async ownedCount(userId: string, buildableId: string, session: DbSession): Promise<number> {
    const snapshot = await this.lockSnapshot(userId, session);
    const placed = snapshot.islands.reduce((total, island) =>
      total + island.placements.filter((placement) => placement.buildableId === buildableId).length, 0);
    return placed + (snapshot.inventory.find((entry) => entry.buildableId === buildableId)?.count ?? 0);
  }

  /** Adds unplaced units to the player's inventory (inside the caller's transaction). */
  async grant(userId: string, buildableId: string, count: number, session: DbSession): Promise<void> {
    if (!this.exists(buildableId)) throw new AppError(ErrorCode.HOME_DEFINITION_NOT_FOUND);
    if (count > 0) await this.inventory.add(userId, buildableId, count, session);
  }

  async placeObject(userId: string, dto: PlaceInput): Promise<HomeMutationResponseDto> {
    const buildable = this.rules.getBuildable(dto.definitionId);
    if (!buildable) throw new AppError(ErrorCode.HOME_DEFINITION_NOT_FOUND);

    const island = this.rules.getIsland(dto.islandId);
    if (!island) throw new AppError(ErrorCode.HOME_ISLAND_NOT_FOUND);

    await this.uow.transaction(async (session) => {
      if ((await this.levelOf(userId, session)) < Math.max(0, buildable.unlockLevel || 0)) throw new AppError(ErrorCode.HOME_LOCKED);

      const snapshot = await this.lockSnapshot(userId, session);
      this.assertUnlocked(snapshot, island.id);
      // A unit from the inventory (already paid in the shop) replaces the build cost and works even for
      // buildables that cannot be bought with `placeCost` (`canPurchase: false`).
      const fromInventory = (snapshot.inventory.find((entry) => entry.buildableId === buildable.id)?.count ?? 0) > 0;
      if (!fromInventory && !buildable.canPurchase) throw new AppError(ErrorCode.HOME_NOT_PURCHASABLE);

      this.validatePlacement(snapshot, island, buildable, dto.originX, dto.originZ, dto.yawDegrees, null);
      this.validateCount(snapshot, buildable, null);

      if (fromInventory) {
        if (!(await this.inventory.consume(userId, buildable.id, 1, session))) throw new AppError(ErrorCode.HOME_NOT_PURCHASABLE);
      } else {
        await this.spendIfNeeded(session, userId, buildable.placeCostCurrencyId, buildable.placeCostAmount);
      }
      const instanceId = ulid();
      await this.homes.upsertPlayerObject(userId, {
        instanceId,
        islandId: island.id,
        definitionId: buildable.id,
        originX: dto.originX,
        originZ: dto.originZ,
        yawDegrees: normalizeYaw(buildable, dto.yawDegrees),
      }, session);
      // A new producing building starts empty: its accrual begins now.
      if (isActiveProduction(buildable.production)) {
        await this.productions.upsert(userId, { instanceId, islandId: island.id, buildableId: buildable.id, sinceUnix: this.clock.nowUnix(), units: [] }, session);
      }
      await this.homes.commitMutation(userId, island.id, session);
    });

    return { ok: true, snapshot: await this.getSnapshot(userId), wallet: await this.ledger.snapshot(userId) };
  }

  async moveObject(userId: string, dto: MoveInput): Promise<HomeMutationResponseDto> {
    const island = this.rules.getIsland(dto.islandId);
    if (!island) throw new AppError(ErrorCode.HOME_ISLAND_NOT_FOUND);

    await this.uow.transaction(async (session) => {
      const snapshot = await this.lockSnapshot(userId, session);
      this.assertUnlocked(snapshot, island.id);
      const placement = this.findPlacement(snapshot, island.id, dto.instanceId);
      if (!placement) throw new AppError(ErrorCode.HOME_OBJECT_NOT_FOUND);

      const buildable = this.rules.getBuildable(placement.buildableId);
      if (!buildable) throw new AppError(ErrorCode.HOME_DEFINITION_NOT_FOUND);
      if (!buildable.canMove) throw new AppError(ErrorCode.HOME_NOT_MOVEABLE);

      this.validatePlacement(snapshot, island, buildable, dto.originX, dto.originZ, dto.yawDegrees, placement.instanceId);

      const yawDegrees = normalizeYaw(buildable, dto.yawDegrees);
      if (placement.isTemplateObject) {
        const templateInstanceId = placement.templateInstanceId || placement.instanceId;
        await this.homes.upsertTemplateState(userId, {
          instanceId: templateInstanceId,
          islandId: island.id,
          definitionId: placement.buildableId,
          templateInstanceId,
          state: "ACTIVE",
          originX: dto.originX,
          originZ: dto.originZ,
          yawDegrees,
          isTemplateObject: true,
        }, session);
      } else {
        await this.homes.upsertPlayerObject(userId, {
          instanceId: placement.instanceId,
          islandId: island.id,
          definitionId: placement.buildableId,
          originX: dto.originX,
          originZ: dto.originZ,
          yawDegrees,
        }, session);
      }

      await this.homes.commitMutation(userId, island.id, session);
    });

    return { ok: true, snapshot: await this.getSnapshot(userId) };
  }

  async removeObject(userId: string, dto: RemoveInput): Promise<HomeMutationResponseDto> {
    const island = this.rules.getIsland(dto.islandId);
    if (!island) throw new AppError(ErrorCode.HOME_ISLAND_NOT_FOUND);

    await this.uow.transaction(async (session) => {
      const snapshot = await this.lockSnapshot(userId, session);
      this.assertUnlocked(snapshot, island.id);
      const placement = this.findPlacement(snapshot, island.id, dto.instanceId);
      if (!placement) throw new AppError(ErrorCode.HOME_OBJECT_NOT_FOUND);

      const buildable = this.rules.getBuildable(placement.buildableId);
      if (!buildable) throw new AppError(ErrorCode.HOME_DEFINITION_NOT_FOUND);
      if (!buildable.canRemove) throw new AppError(ErrorCode.HOME_NOT_REMOVABLE);

      await this.spendIfNeeded(session, userId, buildable.removeCostCurrencyId, buildable.removeCostAmount);

      if (placement.isTemplateObject) {
        const templateInstanceId = placement.templateInstanceId || placement.instanceId;
        await this.homes.upsertTemplateState(userId, {
          instanceId: templateInstanceId,
          islandId: island.id,
          definitionId: placement.buildableId,
          templateInstanceId,
          state: "REMOVED",
          originX: placement.x,
          originZ: placement.z,
          yawDegrees: placement.yawDegrees,
          isTemplateObject: true,
        }, session);
      } else {
        await this.homes.deletePlayerObject(userId, placement.instanceId, session);
      }
      await this.productions.delete(userId, placement.instanceId, session);

      await this.homes.commitMutation(userId, island.id, session);
    });

    return { ok: true, snapshot: await this.getSnapshot(userId), wallet: await this.ledger.snapshot(userId) };
  }

  /**
   * Collects what a producing building stored (formula in `home-production.ts`): a currency producer credits the wallet,
   * a unit EXP producer gives the stored EXP to each stationed monster that still exists. The accrual anchor advances
   * in the same transaction, so a retry never pays twice.
   */
  async collectProduction(userId: string, dto: CollectInput): Promise<HomeMutationResponseDto> {
    const island = this.rules.getIsland(dto.islandId);
    if (!island) throw new AppError(ErrorCode.HOME_ISLAND_NOT_FOUND);

    let collected: HomeCollectedDto | null = null;
    let units: UnitRewardDto[] = [];
    await this.uow.transaction(async (session) => {
      // Re-run after a deadlock: start every attempt clean.
      collected = null;
      units = [];
      const snapshot = await this.lockSnapshot(userId, session);
      this.assertUnlocked(snapshot, island.id);
      const { placement, cfg } = this.requireProducer(snapshot, island.id, dto.instanceId);
      const state = placement.production ?? { sinceUnix: 0, units: [] };
      const nowUnix = this.clock.nowUnix();
      const stored = storedAt(cfg, state.sinceUnix, nowUnix);

      let remaining: string[] = [];
      if (cfg.kind === "currency") {
        if (stored < 1) throw new AppError(ErrorCode.HOME_NOTHING_TO_COLLECT);
        await this.ledger.credit(session, userId, [{ currencyId: cfg.currencyId, amount: stored }]);
        collected = { currencyId: cfg.currencyId, amount: stored };
      } else {
        const stationed = await this.lockStationed(userId, state.units, session);
        if (stationed.length === 0 || stored < 1) throw new AppError(ErrorCode.HOME_NOTHING_TO_COLLECT);
        units = await this.grantUnitExp(userId, stationed, stored, session);
        remaining = stationed.map((record) => record.uid); // sold or fed monsters drop out of the building
      }

      await this.productions.upsert(userId, {
        instanceId: placement.instanceId,
        islandId: island.id,
        buildableId: placement.buildableId,
        sinceUnix: nextAnchor(cfg, state.sinceUnix, nowUnix, stored),
        units: remaining,
      }, session);
      await this.homes.commitMutation(userId, island.id, session);
    });

    if (units.length > 0) await this.rosterCache.invalidate(userId);
    return { ok: true, snapshot: await this.getSnapshot(userId), wallet: await this.ledger.snapshot(userId), collected, units };
  }

  /**
   * Stations up to `unitSlots` monsters in a unit EXP building. The EXP the current monsters accrued is settled first
   * (answered in `units`), then the new list is stored and the accrual restarts now.
   */
  async setProductionUnits(userId: string, dto: SetUnitsInput): Promise<HomeMutationResponseDto> {
    const island = this.rules.getIsland(dto.islandId);
    if (!island) throw new AppError(ErrorCode.HOME_ISLAND_NOT_FOUND);

    let settled: UnitRewardDto[] = [];
    await this.uow.transaction(async (session) => {
      settled = []; // re-run after a deadlock: start clean
      const snapshot = await this.lockSnapshot(userId, session);
      this.assertUnlocked(snapshot, island.id);
      const { placement, cfg } = this.requireProducer(snapshot, island.id, dto.instanceId);
      if (cfg.kind !== "unitExp") throw new AppError(ErrorCode.HOME_NO_PRODUCTION);
      if (dto.uids.length > cfg.unitSlots) throw new AppError(ErrorCode.HOME_PRODUCTION_SLOTS_FULL);

      const state = placement.production ?? { sinceUnix: 0, units: [] };
      const nowUnix = this.clock.nowUnix();

      // One locked read for the current and the requested monsters (a single lock order for concurrent requests).
      const records = await this.lockStationed(userId, [...new Set([...state.units, ...dto.uids])], session);
      const owned = new Map(records.map((record) => [record.uid, record]));
      if (dto.uids.some((uid) => !owned.has(uid))) throw new AppError(ErrorCode.HOME_UNIT_NOT_FOUND);
      if (this.isStationedElsewhere(snapshot, placement, dto.uids)) throw new AppError(ErrorCode.HOME_UNIT_BUSY);

      const stored = storedAt(cfg, state.sinceUnix, nowUnix);
      const current = state.units.map((uid) => owned.get(uid)).filter((record): record is CharacterRecord => !!record);
      if (stored >= 1 && current.length > 0) settled = await this.grantUnitExp(userId, current, stored, session);

      await this.productions.upsert(userId, {
        instanceId: placement.instanceId,
        islandId: island.id,
        buildableId: placement.buildableId,
        sinceUnix: nowUnix,
        units: [...dto.uids],
      }, session);
      await this.homes.commitMutation(userId, island.id, session);
    });

    if (settled.length > 0) await this.rosterCache.invalidate(userId);
    return { ok: true, snapshot: await this.getSnapshot(userId), units: settled };
  }

  private async lockSnapshot(userId: string, session: DbSession): Promise<HomeSnapshotDto> {
    const rows = await this.homes.listObjects(userId, session, true);
    const prefs = await this.homes.getPrefs(userId, session, true);
    const stock = await this.inventory.list(userId, session, true);
    const unlocked = await this.homes.listUnlockedIslands(userId, session, true);
    const production = await this.productions.list(userId, session, true);
    return this.buildSnapshotFromRows(rows, stock, prefs.selectedIslandId, prefs.revision, unlocked, production);
  }

  /** Active production block of a buildable (`undefined` when it produces nothing). */
  private productionCfgOf(buildableId: string): HomeProductionCfg | undefined {
    const cfg = this.rules.getBuildable(buildableId)?.production;
    return isActiveProduction(cfg) ? cfg : undefined;
  }

  /** The placement and its active production block, or the matching error. */
  private requireProducer(snapshot: HomeSnapshotDto, islandId: string, instanceId: string): { placement: HomePlacementDto; cfg: HomeProductionCfg } {
    const placement = this.findPlacement(snapshot, islandId, instanceId);
    if (!placement) throw new AppError(ErrorCode.HOME_OBJECT_NOT_FOUND);
    const cfg = this.productionCfgOf(placement.buildableId);
    if (!cfg) throw new AppError(ErrorCode.HOME_NO_PRODUCTION);
    return { placement, cfg };
  }

  /** True when any of `uids` is stationed in another unit EXP building of the player. */
  private isStationedElsewhere(snapshot: HomeSnapshotDto, current: HomePlacementDto, uids: string[]): boolean {
    if (uids.length === 0) return false;
    for (const island of snapshot.islands) {
      for (const other of island.placements) {
        if (other === current || !other.production || this.productionCfgOf(other.buildableId)?.kind !== "unitExp") continue;
        if (other.production.units.some((uid) => uids.includes(uid))) return true;
      }
    }
    return false;
  }

  /** Locks the stationed monsters that still exist (scoped by owner), in the order of `uids`. */
  private async lockStationed(userId: string, uids: string[], session: DbSession): Promise<CharacterRecord[]> {
    if (uids.length === 0) return [];
    const records = await this.characters.lockByUids(userId, uids, session);
    return [...records].sort((a, b) => uids.indexOf(a.uid) - uids.indexOf(b.uid));
  }

  /** Gives `exp` to each monster like a battle reward does (level ups, max level clamp). */
  private async grantUnitExp(userId: string, records: CharacterRecord[], exp: number, session: DbSession): Promise<UnitRewardDto[]> {
    const units: UnitRewardDto[] = [];
    for (const record of records) {
      const levelUp = this.progression.applyExp(record.stars, record.level, record.currentExp, exp);
      if (levelUp.expConsumed > 0 || levelUp.finalLevel !== record.level || levelUp.finalExp !== record.currentExp) {
        await this.characters.updateProgress(userId, record.uid, levelUp.finalLevel, levelUp.finalExp, session);
      }
      units.push({
        uid: record.uid,
        characterId: record.characterId,
        expGained: levelUp.expConsumed,
        level: levelUp.finalLevel,
        currentExp: levelUp.finalExp,
        leveledUp: levelUp.levelsGained > 0,
      });
    }
    return units;
  }

  private assertUnlocked(snapshot: HomeSnapshotDto, islandId: string): void {
    const island = snapshot.islands.find((entry) => entry.islandId === islandId);
    if (!island?.unlocked) throw new AppError(ErrorCode.HOME_ISLAND_LOCKED);
  }

  /**
   * Debits a place/remove cost inside the mutation's transaction (a failed debit rolls the mutation back). No currency
   * (empty/blank id) or a non-positive amount means free. Mirrored by the Unity offline `OfflineHomeService.TrySpendCost`.
   */
  private async spendIfNeeded(session: DbSession, userId: string, currencyId: string | undefined, amount: number): Promise<void> {
    const cost = Math.max(0, Number(amount ?? 0) | 0);
    const id = (currencyId ?? "").trim();
    if (!id || cost <= 0) return;
    await this.ledger.debit(session, userId, [{ currencyId: id, amount: cost }]);
  }

  private validatePlacement(snapshot: HomeSnapshotDto, island: HomeIslandCfg, buildable: HomeBuildableCfg, originX: number, originZ: number, yawDegrees: number, ignoreInstanceId: string | null): void {
    const footprint = this.rules.footprintFor(buildable, normalizeYaw(buildable, yawDegrees));
    if (!footprint || !Array.isArray(footprint.cells) || footprint.cells.length === 0)
      throw new AppError(ErrorCode.HOME_INVALID_FOOTPRINT);

    const occupancy = this.buildOccupancy(snapshot, island.id, ignoreInstanceId);
    for (const cell of footprint.cells) {
      const x = originX + Number(cell.x ?? 0);
      const z = originZ + Number(cell.z ?? 0);

      if (x < 0 || z < 0 || x >= island.gridSizeX || z >= island.gridSizeZ)
        throw new AppError(ErrorCode.HOME_OUT_OF_BOUNDS);

      if (!isBuildableCell(island, x, z))
        throw new AppError(ErrorCode.HOME_CELL_BLOCKED);

      const existing = occupancy.get(keyOf(x, z));
      if (existing && existing !== ignoreInstanceId)
        throw new AppError(ErrorCode.HOME_OVERLAP);
    }
  }

  private validateCount(snapshot: HomeSnapshotDto, buildable: HomeBuildableCfg, ignoreInstanceId: string | null): void {
    if (!buildable.countsTowardsLimit) return;
    const maxCount = buildable.isUnique ? 1 : Math.max(0, Number(buildable.maxCount ?? 0) | 0);
    if (maxCount <= 0) return;

    let total = 0;
    for (const island of snapshot.islands) {
      for (const placement of island.placements) {
        if (placement.buildableId !== buildable.id) continue;
        if (ignoreInstanceId && placement.instanceId === ignoreInstanceId) continue;
        total++;
      }
    }

    if (total >= maxCount) throw new AppError(ErrorCode.HOME_LIMIT_REACHED);
  }

  private buildOccupancy(snapshot: HomeSnapshotDto, islandId: string, ignoreInstanceId: string | null): Map<string, string> {
    const map = new Map<string, string>();
    const island = snapshot.islands.find((entry) => entry.islandId === islandId);
    if (!island) return map;

    for (const placement of island.placements) {
      if (!placement || (ignoreInstanceId && placement.instanceId === ignoreInstanceId)) continue;
      const buildable = this.rules.getBuildable(placement.buildableId);
      const footprint = this.rules.footprintFor(buildable, placement.yawDegrees);
      if (!footprint) continue;

      for (const cell of footprint.cells) {
        map.set(keyOf(placement.x + Number(cell.x ?? 0), placement.z + Number(cell.z ?? 0)), placement.instanceId);
      }
    }

    return map;
  }

  private findPlacement(snapshot: HomeSnapshotDto, islandId: string, instanceId: string): HomePlacementDto | null {
    const island = snapshot.islands.find((entry) => entry.islandId === islandId);
    if (!island) return null;

    for (const placement of island.placements) {
      if (placement.instanceId === instanceId) return placement;
    }
    return null;
  }

  private buildSnapshotFromRows(rows: HomeObjectRow[], inventory: HomeInventoryEntryDto[], selectedIslandId: string | null, revision: number, unlockedIslandIds: string[], productionRows: HomeProductionRow[]): HomeSnapshotDto {
    const catalog = this.rules.catalog();
    const islands: HomeIslandSnapshotDto[] = [];
    const bought = new Set(unlockedIslandIds);
    const productionByInstance = new Map(productionRows.map((row) => [row.instanceId, row]));

    for (const island of catalog.islands) {
      const removedTemplateIds = new Set<string>();
      const templateOverrides = new Map<string, HomeObjectRow>();
      const playerPlacements: HomePlacementDto[] = [];
      const islandRows = rows.filter((entry) => entry.islandId === island.id);

      for (const row of islandRows) {
        if (row.isTemplateObject && row.templateInstanceId) {
          if (row.state === "REMOVED") removedTemplateIds.add(row.templateInstanceId);
          else templateOverrides.set(row.templateInstanceId, row);
          continue;
        }

        if (row.state === "ACTIVE") {
          playerPlacements.push({
            instanceId: row.instanceId,
            templateInstanceId: null,
            buildableId: row.definitionId,
            x: row.originX,
            z: row.originZ,
            yawDegrees: row.yawDegrees,
            isTemplateObject: false,
          });
        }
      }

      const placements: HomePlacementDto[] = [];
      for (const placement of island.defaultPlacements) {
        if (removedTemplateIds.has(placement.templateInstanceId)) continue;

        const override = templateOverrides.get(placement.templateInstanceId);
        if (override) {
          placements.push({
            instanceId: override.templateInstanceId || override.instanceId,
            templateInstanceId: override.templateInstanceId,
            buildableId: override.definitionId,
            x: override.originX,
            z: override.originZ,
            yawDegrees: override.yawDegrees,
            isTemplateObject: true,
          });
          continue;
        }

        placements.push({
          instanceId: placement.templateInstanceId,
          templateInstanceId: placement.templateInstanceId,
          buildableId: placement.buildableId,
          x: placement.x,
          z: placement.z,
          yawDegrees: placement.yawDegrees,
          isTemplateObject: true,
        });
      }

      placements.push(...playerPlacements);
      for (const placement of placements) {
        // Producing buildables carry their state; a building the player never touched starts full (sinceUnix 0).
        if (!this.productionCfgOf(placement.buildableId)) continue;
        const row = productionByInstance.get(placement.instanceId);
        placement.production = row ? { sinceUnix: row.sinceUnix, units: [...row.units] } : { sinceUnix: 0, units: [] };
      }

      islands.push({
        islandId: island.id,
        unlocked: island.unlockedByDefault || bought.has(island.id),
        placements,
        removedTemplateInstanceIds: Array.from(removedTemplateIds),
        revision,
      });
    }

    const fallbackIsland = catalog.defaultIslandId || catalog.islands[0]?.id || null;
    return {
      selectedIslandId: selectedIslandId || fallbackIsland,
      islands,
      inventory: inventory.map((entry) => ({ buildableId: entry.buildableId, count: entry.count })),
      revision,
      serverTimeUnix: this.clock.nowUnix(),
    };
  }
}
