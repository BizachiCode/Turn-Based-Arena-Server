// Drizzle implementation of the rune persistence port (equip/unequip are transactional TS).

import { and, asc, count, eq, gt, gte, isNotNull, isNull, inArray, lte, type SQL } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userCharacters, userRuneCapacity, userRunes } from "../../infrastructure/database/schema/index.js";
import { parseSubstats } from "./rune.mapper.js";
import type { NewRune, RuneRecord, RuneRepository, RuneSearchFilters, Substat } from "./rune.ports.js";

const columns = {
  id: userRunes.id,
  uid: userRunes.publicUid,
  setId: userRunes.setId,
  slot: userRunes.slot,
  tier: userRunes.tier,
  variant: userRunes.variant,
  quality: userRunes.quality,
  level: userRunes.level,
  mainStatType: userRunes.mainStatType,
  mainStatValue: userRunes.mainStatValue,
  substats: userRunes.substats,
  origin: userRunes.origin,
  locked: userRunes.locked,
  favorite: userRunes.favorite,
  equippedToUid: userRunes.equippedToUid,
  equippedAt: userRunes.equippedAt,
  createdAt: userRunes.createdAt,
};

type Row = { [K in keyof typeof columns]: (typeof columns)[K]["_"]["data"] };

function toRecord(row: Row): RuneRecord {
  return {
    ...row,
    substats: parseSubstats(row.substats),
    locked: row.locked === 1,
    favorite: row.favorite === 1,
  };
}

export class DrizzleRuneRepository extends DrizzleRepository implements RuneRepository {
  constructor(database: Database) {
    super(database);
  }

  async search(userId: string, filters: RuneSearchFilters): Promise<RuneRecord[]> {
    const conditions: SQL[] = [eq(userRunes.userId, userId)];
    if (filters.setId) conditions.push(eq(userRunes.setId, filters.setId));
    if (filters.slot != null) conditions.push(eq(userRunes.slot, filters.slot));
    if (filters.qMin != null) conditions.push(gte(userRunes.quality, filters.qMin));
    if (filters.qMax != null) conditions.push(lte(userRunes.quality, filters.qMax));
    if (filters.lMin != null) conditions.push(gte(userRunes.level, filters.lMin));
    if (filters.lMax != null) conditions.push(lte(userRunes.level, filters.lMax));
    if (filters.equipped === true) conditions.push(isNotNull(userRunes.equippedToUid));
    if (filters.equipped === false) conditions.push(isNull(userRunes.equippedToUid));
    if (filters.equippedTo) conditions.push(eq(userRunes.equippedToUid, filters.equippedTo));
    if (filters.lastId != null) conditions.push(gt(userRunes.id, filters.lastId));

    const rows = await this.database.select(columns).from(userRunes).where(and(...conditions)).orderBy(asc(userRunes.id)).limit(filters.pageSize);
    return rows.map(toRecord);
  }

  async freeCountsBySet(userId: string): Promise<Array<{ setId: string; count: number }>> {
    const rows = await this.database.select({ setId: userRunes.setId, count: count() }).from(userRunes)
      .where(and(eq(userRunes.userId, userId), isNull(userRunes.equippedToUid)))
      .groupBy(userRunes.setId)
      .orderBy(asc(userRunes.setId));
    return rows.map((row) => ({ setId: row.setId, count: Number(row.count) }));
  }

  async lockCapacity(userId: string, defaultCapacity: number, session: DbSession): Promise<{ capacity: number; count: number }> {
    const db = this.db(session);
    await db.insert(userRuneCapacity).ignore().values({ userId, runeCapacity: defaultCapacity });
    const [capacity] = await db.select({ value: userRuneCapacity.runeCapacity }).from(userRuneCapacity)
      .where(eq(userRuneCapacity.userId, userId)).for("update");
    const [owned] = await db.select({ value: count() }).from(userRunes).where(eq(userRunes.userId, userId));
    return { capacity: capacity?.value ?? defaultCapacity, count: Number(owned?.value ?? 0) };
  }

  async insertRune(userId: string, rune: NewRune, session: DbSession): Promise<void> {
    await this.db(session).insert(userRunes).values({
      publicUid: rune.uid,
      userId,
      setId: rune.setId,
      slot: rune.slot,
      tier: rune.tier,
      variant: rune.variant,
      quality: rune.quality,
      level: rune.level,
      mainStatType: rune.mainStatType,
      mainStatValue: rune.mainStatValue,
      substats: rune.substats ?? [],
      origin: rune.origin,
    });
  }

  async find(userId: string, uid: string, session?: DbSession, forUpdate = false): Promise<RuneRecord | null> {
    const query = this.db(session).select(columns).from(userRunes)
      .where(and(eq(userRunes.publicUid, uid), eq(userRunes.userId, userId))).limit(1);
    const [row] = session && forUpdate ? await query.for("update") : await query;
    return row ? toRecord(row) : null;
  }

  async listEquippedOn(userId: string, characterUids: string[], session?: DbSession): Promise<RuneRecord[]> {
    if (characterUids.length === 0) return [];
    const rows = await this.db(session).select(columns).from(userRunes)
      .where(and(eq(userRunes.userId, userId), inArray(userRunes.equippedToUid, characterUids)));
    return rows.map(toRecord);
  }

  async updateProgress(userId: string, uid: string, level: number, mainStatValue: number, substats: Substat[], session: DbSession): Promise<void> {
    await this.db(session).update(userRunes).set({ level, mainStatValue, substats })
      .where(and(eq(userRunes.publicUid, uid), eq(userRunes.userId, userId)));
  }

  async delete(userId: string, uid: string, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).delete(userRunes).where(and(eq(userRunes.publicUid, uid), eq(userRunes.userId, userId))));
  }

  async setFlags(userId: string, uid: string, flags: { locked?: boolean; favorite?: boolean }): Promise<number> {
    const set: { locked?: number; favorite?: number } = {};
    if (flags.locked !== undefined) set.locked = flags.locked ? 1 : 0;
    if (flags.favorite !== undefined) set.favorite = flags.favorite ? 1 : 0;
    if (Object.keys(set).length === 0) return 0;

    // MySQL reports 0 affected rows for no-op updates, so existence is checked explicitly.
    if (!(await this.find(userId, uid))) return 0;
    await this.database.update(userRunes).set(set).where(and(eq(userRunes.publicUid, uid), eq(userRunes.userId, userId)));
    return 1;
  }

  async characterExists(userId: string, characterUid: string, session: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ id: userCharacters.id }).from(userCharacters)
      .where(and(eq(userCharacters.publicUid, characterUid), eq(userCharacters.userId, userId))).limit(1).for("update");
    return !!row;
  }

  async clearSlot(userId: string, characterUid: string, slot: number, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).update(userRunes).set({ equippedToUid: null, equippedAt: null }).where(and(
      eq(userRunes.userId, userId),
      eq(userRunes.equippedToUid, characterUid),
      eq(userRunes.slot, slot),
    )));
  }

  async setEquipped(userId: string, uid: string, characterUid: string | null, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).update(userRunes)
      .set({ equippedToUid: characterUid, equippedAt: characterUid ? new Date() : null })
      .where(and(eq(userRunes.publicUid, uid), eq(userRunes.userId, userId))));
  }
}
