// src/modules/roster/roster.service.ts
// Roster use cases: list, storage, capacity, power-up, evolve.

import { noActivity, type PlayerActivitySink } from "../../shared/kernel/activity.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { cryptoRandom, type RandomSource } from "../../shared/kernel/random.js";
import { Idempotency } from "../../shared/kernel/idempotency.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { MonsterProgression } from "../progression/progression.rules.js";
import type {
  EvolveResultDto,
  ExpandResultDto,
  LockResultDto,
  PowerUpResultDto,
  SellResultDto,
  RosterListResultDto,
  StorageCapsResultDto,
  StorageListResultDto,
  StorageMoveResultDto,
} from "./roster.dto.js";
import { toCharacterDtoList } from "./roster.mapper.js";
import type { CapacityDefaults, CharacterRecord, CharacterRepository, Location, ReservedUnits, RosterRules, SkillUpRules } from "./roster.ports.js";
import type { RosterCache } from "./roster.cache.js";

const MAX_PAGE = 500;
const MAX_FODDERS = 100;

function sanitizePaging(offset?: number, limit?: number) {
  return {
    offset: Math.max(0, Number(offset ?? 0) | 0),
    limit: Math.min(MAX_PAGE, Math.max(1, Number(limit ?? 200) | 0)),
  };
}

export class RosterService {
  constructor(
    private readonly characters: CharacterRepository,
    private readonly cache: RosterCache,
    private readonly ledger: WalletLedger,
    private readonly progression: MonsterProgression,
    private readonly capacityDefaults: CapacityDefaults,
    private readonly uow: UnitOfWork,
    /** Receives `monster_powerup` (one per power-up) for the guild quests. */
    private readonly activity: PlayerActivitySink = noActivity,
    /** Skill-ups on power-up (same monster / skill-up material fodders); none when absent. */
    private readonly skillUps?: SkillUpRules,
    private readonly random: RandomSource = cryptoRandom,
    /** Selling / slot purchases and the units kept in team setups (arena defense). */
    private readonly extras: { rules?: RosterRules; reserved?: ReservedUnits } = {},
    /** Stored responses of repeated `requestId`s (power-up, evolve, sell, expand); default: no idempotency. */
    private readonly idempotency: Idempotency = new Idempotency(null, uow),
  ) {}

  async listRoster(userId: string, offset?: number, limit?: number): Promise<RosterListResultDto> {
    const paging = sanitizePaging(offset, limit);

    if (paging.offset === 0) {
      const cached = await this.cache.getRoster(userId);
      if (cached && cached.items.length >= Math.min(paging.limit, cached.total)) {
        return {
          total: cached.total,
          items: cached.items.slice(0, paging.limit),
          nextOffset: paging.limit < cached.total ? paging.limit : null,
        };
      }
    }

    // Version token BEFORE the database reads: a mutation committed meanwhile bumps it and this write is ignored.
    const token = paging.offset === 0 ? await this.cache.token(userId) : "";
    const total = await this.characters.countByLocation(userId, "BAG");
    const items = toCharacterDtoList(await this.characters.listByLocation(userId, "BAG", paging.offset, paging.limit));
    const nextOffset = paging.offset + items.length < total ? paging.offset + items.length : null;

    if (paging.offset === 0) await this.cache.setRoster(userId, { total, items }, token);
    return { total, items, nextOffset };
  }

  async storageList(userId: string, location?: string, offset?: number, limit?: number): Promise<StorageListResultDto> {
    const loc: Location = String(location || "STORAGE").toUpperCase() === "BAG" ? "BAG" : "STORAGE";
    const paging = sanitizePaging(offset, limit);
    const total = await this.characters.countByLocation(userId, loc);
    const storage = toCharacterDtoList(await this.characters.listByLocation(userId, loc, paging.offset, paging.limit));
    return { storage, total };
  }

  async storageCaps(userId: string): Promise<StorageCapsResultDto> {
    const cached = await this.cache.getCaps(userId);
    if (cached) return cached;

    const token = await this.cache.token(userId);
    const result = await this.uow.transaction(async (session) => ({
      ...(await this.characters.getCapacity(userId, this.capacityDefaults(), session)),
      ...(await this.characters.getCounts(userId, session)),
    }));
    await this.cache.setCaps(userId, result, token);
    return result;
  }

  async storageMove(userId: string, target: Location, uids: string[]): Promise<StorageMoveResultDto> {
    const unique = [...new Set(uids)];
    if (unique.length === 0) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "EMPTY" });
    if (unique.length > MAX_PAGE) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "TOO_MANY" });

    const source: Location = target === "STORAGE" ? "BAG" : "STORAGE";

    const result = await this.uow.transaction(async (session) => {
      const caps = await this.characters.getCapacity(userId, this.capacityDefaults(), session, true);
      const counts = await this.characters.getCounts(userId, session, true);

      const found = await this.characters.lockByUids(userId, unique, session);
      if (found.length !== unique.length || found.some((entry) => entry.location !== source)) {
        throw new AppError(ErrorCode.ROSTER_WRONG_LOCATION);
      }

      const free = target === "STORAGE"
        ? Math.max(0, caps.storageCapacity - counts.storageCount)
        : Math.max(0, caps.bagCapacity - counts.bagCount);
      if (free < unique.length) throw new AppError(ErrorCode.ROSTER_CAPACITY_FULL, { target });

      const moved = await this.characters.moveCharacters(userId, source, target, unique, session);
      if (moved !== unique.length) throw new AppError(ErrorCode.SERVER_ERROR, { detail: "MOVE_CONFLICT" });

      const bagCount = target === "STORAGE" ? counts.bagCount - moved : counts.bagCount + moved;
      const storageCount = target === "STORAGE" ? counts.storageCount + moved : counts.storageCount - moved;
      return { target, moved, movedUids: unique, ...caps, bagCount, storageCount };
    });

    await this.cache.invalidate(userId);
    return result;
  }

  async powerUp(userId: string, targetUid: string, fodderUids: string[], requestId?: string): Promise<PowerUpResultDto> {
    const repeated = await this.idempotency.replay<PowerUpResultDto>(userId, requestId, "power_up");
    if (repeated) return repeated;
    const fodders = this.validateFodderList(targetUid, fodderUids);

    const { value: result, replayed } = await this.idempotency.run<PowerUpResultDto>(userId, requestId, "power_up", async (session) => {
      const { target, fodderRecords } = await this.lockTargetAndFodders(userId, targetUid, fodders, session);

      // Skill-ups: every fodder that is the same monster or a skill-up material (Devilmon) levels up
      // one random skill that is not maxed. A max-level monster can still be powered up for skill-ups.
      const skills = this.skillUps?.skills(target.characterId, target.awakeningIndex ?? 0) ?? [];
      const skillLevels = skills.map((skill, index) => Math.max(1, Math.min(skill.maxLevel, Math.floor(target.skillLevels[index] ?? 1) || 1)));
      const skillUpFodders = this.skillUps
        ? fodderRecords.filter((fodder) => fodder.characterId === target.characterId || this.skillUps!.isSkillUpMaterial(fodder.characterId)).length
        : 0;
      const canSkillUp = skillUpFodders > 0 && skillLevels.some((level, index) => level < skills[index].maxLevel);

      const maxLevel = this.progression.maxLevelForStars(target.stars);
      if (target.level >= maxLevel && !canSkillUp) throw new AppError(ErrorCode.ROSTER_AT_MAX_LEVEL);

      let extraExp = 0;
      for (const fodder of fodderRecords) extraExp += this.progression.powerUpExpYield(fodder.stars, fodder.level);
      const { currencyId, price } = this.progression.powerUpPrice(fodderRecords.map((fodder) => fodder.stars));

      await this.ledger.debit(session, userId, [{ currencyId, amount: price }]);

      const levelUp = this.progression.applyExp(target.stars, target.level, target.currentExp, extraExp);
      await this.characters.updateProgress(userId, targetUid, levelUp.finalLevel, levelUp.finalExp, session);

      const skillUps: PowerUpResultDto["skillUps"] = [];
      for (let i = 0; i < skillUpFodders; i++) {
        const open = skillLevels.map((level, index) => (level < skills[index].maxLevel ? index : -1)).filter((index) => index >= 0);
        if (open.length === 0) break;
        const index = open[this.random.int(open.length)];
        skillLevels[index] += 1;
        skillUps.push({ skillIndex: index, skillId: skills[index].id, level: skillLevels[index] });
      }
      if (skillUps.length > 0) await this.characters.updateSkillLevels(userId, targetUid, skillLevels, session);

      await this.consumeFodders(userId, fodders, session);

      return {
        targetUid,
        currencyId,
        priceSpent: price,
        expAdded: extraExp,
        levelsGained: levelUp.levelsGained,
        newLevel: levelUp.finalLevel,
        newCurrentExp: levelUp.finalExp,
        removedFodders: fodders,
        skillUps,
        skillLevels: skillLevels.length > 0 ? skillLevels : [...target.skillLevels],
      };
    });

    if (!replayed) {
      await this.cache.invalidate(userId);
      await this.activity.record(userId, "monster_powerup");
    }
    return result;
  }

  async evolve(userId: string, targetUid: string, fodderUids: string[], requestId?: string): Promise<EvolveResultDto> {
    const repeated = await this.idempotency.replay<EvolveResultDto>(userId, requestId, "evolve");
    if (repeated) return repeated;
    const fodders = this.validateFodderList(targetUid, fodderUids);

    const { value: result, replayed } = await this.idempotency.run<EvolveResultDto>(userId, requestId, "evolve", async (session) => {
      const { target, fodderRecords } = await this.lockTargetAndFodders(userId, targetUid, fodders, session);

      const step = this.progression.evolveStep(target.stars);
      if (!step.stepDefined) throw new AppError(ErrorCode.ROSTER_EVOLVE_STEP_MISSING);

      const points = fodderRecords.reduce((sum, fodder) => sum + Math.max(1, Math.min(6, fodder.stars)), 0);
      if (points < step.need) throw new AppError(ErrorCode.ROSTER_INSUFFICIENT_STAR_POINTS);

      const price = Math.max(0, step.costPerStarUnit * points);
      await this.ledger.debit(session, userId, [{ currencyId: step.currencyId, amount: price }]);

      await this.characters.updateStars(userId, targetUid, step.toStars, session);
      await this.consumeFodders(userId, fodders, session);

      return {
        targetUid,
        newStars: step.toStars,
        resetLevelTo: 1,
        resetExpTo: 0,
        starPointsSpent: points,
        currencyId: step.currencyId,
        priceSpent: price,
        removedFodders: fodders,
      };
    });

    if (!replayed) {
      await this.cache.invalidate(userId);
      await this.activity.record(userId, "monster_powerup");
      await this.activity.record(userId, "monster_evolve");
    }
    return result;
  }

  /** Locks or unlocks a monster (locked monsters cannot be consumed or sold). */
  async setLocked(userId: string, uid: string, locked: boolean): Promise<LockResultDto> {
    await this.uow.transaction(async (session) => {
      const [record] = await this.characters.lockByUids(userId, [uid], session);
      if (!record) throw new AppError(ErrorCode.ROSTER_CHARACTER_NOT_FOUND);
      if (record.locked !== locked) await this.characters.updateLocked(userId, uid, locked, session);
    });
    await this.cache.invalidate(userId);
    return { uid, locked };
  }

  /**
   * Sells monsters for the configured currency (`gameplay.monsterSell`). Every monster must be owned, unlocked, without
   * equipped runes and out of the arena defense; all or nothing.
   */
  async sell(userId: string, uids: string[], requestId?: string): Promise<SellResultDto> {
    const repeated = await this.idempotency.replay<SellResultDto>(userId, requestId, "roster_sell");
    if (repeated) return repeated;
    const rules = this.extras.rules?.();
    if (!rules) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "SELL_DISABLED" });
    const list = [...new Set(uids.filter((uid) => !!uid))];
    if (list.length === 0) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "EMPTY_UIDS" });

    const { value: result, replayed } = await this.idempotency.run<SellResultDto>(userId, requestId, "roster_sell", async (session) => {
      const records = await this.characters.lockByUids(userId, list, session);
      if (records.length !== list.length) throw new AppError(ErrorCode.ROSTER_CHARACTER_NOT_FOUND);
      if (records.some((record) => record.locked)) throw new AppError(ErrorCode.ROSTER_CHARACTER_LOCKED);
      if ((await this.characters.countEquippedRunes(userId, list, session)) > 0) throw new AppError(ErrorCode.ROSTER_FODDER_HAS_RUNES);
      await this.assertNotReserved(userId, list, session);

      const { currencyId, priceByStars, pricePerLevel } = rules.sell;
      const amount = records.reduce((sum, record) => {
        const stars = Math.max(1, Math.min(6, record.stars));
        return sum + Math.max(0, priceByStars[stars] ?? priceByStars[priceByStars.length - 1] ?? 0) + Math.max(0, pricePerLevel) * Math.max(0, record.level - 1);
      }, 0);
      const deleted = await this.characters.deleteCharacters(userId, list, session);
      if (deleted !== list.length) throw new AppError(ErrorCode.SERVER_ERROR, { detail: "SELL_DELETE_CONFLICT" });
      if (amount > 0) await this.ledger.credit(session, userId, [{ currencyId, amount }]);
      return { soldUids: list, currencyId, amount, wallet: await this.ledger.snapshot(userId, session) };
    });

    if (!replayed) await this.cache.invalidate(userId);
    return result;
  }

  /** Buys `step` more bag / storage slots (`gameplay.capacityExpansion`), up to the configured maximum. */
  async expand(userId: string, target: Location, requestId?: string): Promise<ExpandResultDto> {
    const repeated = await this.idempotency.replay<ExpandResultDto>(userId, requestId, "roster_expand");
    if (repeated) return repeated;
    const rules = this.extras.rules?.();
    if (!rules) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "EXPAND_DISABLED" });
    const rule = target === "STORAGE" ? rules.expansion.storage : rules.expansion.bag;

    const { value: result, replayed } = await this.idempotency.run<ExpandResultDto>(userId, requestId, "roster_expand", async (session) => {
      const capacity = await this.characters.getCapacity(userId, this.capacityDefaults(), session, true);
      const current = target === "STORAGE" ? capacity.storageCapacity : capacity.bagCapacity;
      if (current + rule.step > rule.max) throw new AppError(ErrorCode.ROSTER_CAPACITY_MAX, { fields: { max: rule.max } });

      const purchases = Math.max(0, Math.floor((current - rule.initial) / rule.step));
      const price = Math.max(0, rule.costBase + rule.costIncrement * purchases);
      if (price > 0) await this.ledger.debit(session, userId, [{ currencyId: rule.currencyId, amount: price }]);
      const next = target === "STORAGE"
        ? { ...capacity, storageCapacity: current + rule.step }
        : { ...capacity, bagCapacity: current + rule.step };
      await this.characters.setCapacity(userId, next, session);
      return {
        target,
        bagCapacity: next.bagCapacity,
        storageCapacity: next.storageCapacity,
        currencyId: rule.currencyId,
        priceSpent: price,
        wallet: await this.ledger.snapshot(userId, session),
      };
    });

    if (!replayed) await this.cache.invalidate(userId);
    return result;
  }

  private async assertNotReserved(userId: string, uids: string[], session: DbSession): Promise<void> {
    if (!this.extras.reserved) return;
    const reserved = await this.extras.reserved.reservedUids(userId, session);
    if (uids.some((uid) => reserved.has(uid))) throw new AppError(ErrorCode.ROSTER_IN_DEFENSE);
  }

  private validateFodderList(targetUid: string, fodderUids: string[]): string[] {
    if (!targetUid) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "NO_TARGET" });
    const fodders = [...new Set(fodderUids)];
    if (fodders.length === 0) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "EMPTY_FODDERS" });
    if (fodders.length > MAX_FODDERS) throw new AppError(ErrorCode.ROSTER_INVALID_PAYLOAD, { detail: "TOO_MANY_FODDERS" });
    if (fodders.includes(targetUid)) throw new AppError(ErrorCode.ROSTER_CANNOT_CONSUME_TARGET);
    return fodders;
  }

  /** Locks the target and the fodders, enforcing ownership, location and lock flags. */
  private async lockTargetAndFodders(userId: string, targetUid: string, fodders: string[], session: DbSession) {
    const records = await this.characters.lockByUids(userId, [targetUid, ...fodders], session);
    const byUid = new Map(records.map((record) => [record.uid, record]));

    // A locked target can still be powered up / evolved: the lock only protects it from being consumed or sold.
    const target = byUid.get(targetUid);
    if (!target) throw new AppError(ErrorCode.ROSTER_CHARACTER_NOT_FOUND);
    if (target.location !== "BAG") throw new AppError(ErrorCode.ROSTER_WRONG_LOCATION);

    const fodderRecords: CharacterRecord[] = [];
    for (const uid of fodders) {
      const fodder = byUid.get(uid);
      if (!fodder || fodder.location !== "BAG") throw new AppError(ErrorCode.ROSTER_FODDER_NOT_FOUND);
      if (fodder.locked) throw new AppError(ErrorCode.ROSTER_CHARACTER_LOCKED);
      fodderRecords.push(fodder);
    }

    if ((await this.characters.countEquippedRunes(userId, fodders, session)) > 0) {
      throw new AppError(ErrorCode.ROSTER_FODDER_HAS_RUNES);
    }
    await this.assertNotReserved(userId, fodders, session);

    return { target, fodderRecords };
  }

  private async consumeFodders(userId: string, fodders: string[], session: DbSession): Promise<void> {
    const deleted = await this.characters.deleteFromBag(userId, fodders, session);
    if (deleted !== fodders.length) throw new AppError(ErrorCode.SERVER_ERROR, { detail: "FODDER_DELETE_CONFLICT" });
  }
}
