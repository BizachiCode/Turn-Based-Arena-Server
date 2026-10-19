// Drizzle implementation of the character/roster persistence port.

import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userCharacterCapacity, userCharacters, userRunes } from "../../infrastructure/database/schema/index.js";
import { parseSkillLevels } from "./roster.mapper.js";
import type { Capacity, CharacterRecord, CharacterRepository, Location, LocationCounts, NewCharacter } from "./roster.ports.js";

const columns = {
  uid: userCharacters.publicUid,
  characterId: userCharacters.characterId,
  stars: userCharacters.stars,
  level: userCharacters.level,
  currentExp: userCharacters.currentExp,
  awakeningIndex: userCharacters.awakeningIndex,
  skillLevels: userCharacters.skillLevels,
  locked: userCharacters.locked,
  location: userCharacters.location,
  createdAt: userCharacters.createdAt,
};

type Row = { [K in keyof typeof columns]: (typeof columns)[K]["_"]["data"] };

function toRecord(row: Row): CharacterRecord {
  return {
    uid: row.uid,
    characterId: row.characterId,
    stars: row.stars,
    level: row.level,
    currentExp: row.currentExp,
    awakeningIndex: row.awakeningIndex,
    skillLevels: parseSkillLevels(row.skillLevels),
    locked: row.locked === 1,
    location: row.location,
    createdAt: row.createdAt,
  };
}

export class DrizzleCharacterRepository extends DrizzleRepository implements CharacterRepository {
  constructor(database: Database) {
    super(database);
  }

  async countByLocation(userId: string, location: Location, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ c: count() }).from(userCharacters)
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.location, location)));
    return Number(row?.c ?? 0);
  }

  async listByLocation(userId: string, location: Location, offset: number, limit: number, session?: DbSession): Promise<CharacterRecord[]> {
    const rows = await this.db(session).select(columns).from(userCharacters)
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.location, location)))
      .orderBy(asc(userCharacters.id))
      .limit(limit)
      .offset(offset);
    return rows.map(toRecord);
  }

  async listByUids(userId: string, uids: string[], session?: DbSession): Promise<CharacterRecord[]> {
    if (uids.length === 0) return [];
    const rows = await this.db(session).select(columns).from(userCharacters)
      .where(and(eq(userCharacters.userId, userId), inArray(userCharacters.publicUid, uids)));
    return rows.map(toRecord);
  }

  async lockByUids(userId: string, uids: string[], session: DbSession): Promise<CharacterRecord[]> {
    if (uids.length === 0) return [];
    const rows = await this.db(session).select(columns).from(userCharacters)
      .where(and(eq(userCharacters.userId, userId), inArray(userCharacters.publicUid, uids)))
      .for("update");
    return rows.map(toRecord);
  }

  async ownsCharacterId(userId: string, characterId: string, session?: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ id: userCharacters.id }).from(userCharacters)
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.characterId, characterId))).limit(1);
    return !!row;
  }

  async getCapacity(userId: string, defaults: Capacity, session: DbSession, forUpdate = false): Promise<Capacity> {
    const db = this.db(session);
    await db.insert(userCharacterCapacity).ignore()
      .values({ userId, bagCapacity: defaults.bagCapacity, storageCapacity: defaults.storageCapacity });
    const query = db.select({ bagCapacity: userCharacterCapacity.bagCapacity, storageCapacity: userCharacterCapacity.storageCapacity })
      .from(userCharacterCapacity).where(eq(userCharacterCapacity.userId, userId)).limit(1);
    const [row] = forUpdate ? await query.for("update") : await query;
    return row ?? { ...defaults };
  }

  async getCounts(userId: string, session: DbSession, forUpdate = false): Promise<LocationCounts> {
    const query = this.db(session).select({ location: userCharacters.location }).from(userCharacters).where(eq(userCharacters.userId, userId));
    const rows = forUpdate ? await query.for("update") : await query;
    let bagCount = 0;
    let storageCount = 0;
    for (const row of rows) {
      if (row.location === "STORAGE") storageCount++;
      else bagCount++;
    }
    return { bagCount, storageCount };
  }

  async moveCharacters(userId: string, from: Location, to: Location, uids: string[], session: DbSession): Promise<number> {
    if (uids.length === 0) return 0;
    return affectedRows(await this.db(session).update(userCharacters).set({ location: to }).where(and(
      eq(userCharacters.userId, userId),
      eq(userCharacters.location, from),
      inArray(userCharacters.publicUid, uids),
    )));
  }

  async updateProgress(userId: string, uid: string, level: number, currentExp: number, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).update(userCharacters).set({ level, currentExp })
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.publicUid, uid))));
  }

  async updateLocked(userId: string, uid: string, locked: boolean, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).update(userCharacters).set({ locked: locked ? 1 : 0 })
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.publicUid, uid))));
  }

  async deleteCharacters(userId: string, uids: string[], session: DbSession): Promise<number> {
    if (uids.length === 0) return 0;
    return affectedRows(await this.db(session).delete(userCharacters)
      .where(and(eq(userCharacters.userId, userId), inArray(userCharacters.publicUid, uids))));
  }

  async setCapacity(userId: string, capacity: Capacity, session: DbSession): Promise<void> {
    await this.db(session).update(userCharacterCapacity)
      .set({ bagCapacity: capacity.bagCapacity, storageCapacity: capacity.storageCapacity })
      .where(eq(userCharacterCapacity.userId, userId));
  }

  async updateSkillLevels(userId: string, uid: string, skillLevels: number[], session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).update(userCharacters).set({ skillLevels })
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.publicUid, uid))));
  }

  async updateStars(userId: string, uid: string, stars: number, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).update(userCharacters).set({ stars, level: 1, currentExp: 0 })
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.publicUid, uid))));
  }

  async updateAwakening(userId: string, uid: string, awakeningIndex: number, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).update(userCharacters).set({ awakeningIndex })
      .where(and(eq(userCharacters.userId, userId), eq(userCharacters.publicUid, uid))));
  }

  async deleteFromBag(userId: string, uids: string[], session: DbSession): Promise<number> {
    if (uids.length === 0) return 0;
    return affectedRows(await this.db(session).delete(userCharacters).where(and(
      eq(userCharacters.userId, userId),
      eq(userCharacters.location, "BAG"),
      inArray(userCharacters.publicUid, uids),
    )));
  }

  async insertCharacter(userId: string, character: NewCharacter, session: DbSession): Promise<void> {
    await this.db(session).insert(userCharacters).values({
      publicUid: character.uid,
      userId,
      characterId: character.characterId,
      stars: character.stars,
      level: character.level,
      currentExp: character.currentExp,
      awakeningIndex: character.awakeningIndex,
      skillLevels: character.skillLevels ?? [],
      location: character.location,
    });
  }

  async countEquippedRunes(userId: string, characterUids: string[], session: DbSession): Promise<number> {
    if (characterUids.length === 0) return 0;
    const rows = await this.db(session).select({ id: userRunes.id }).from(userRunes).where(and(
      eq(userRunes.userId, userId),
      isNotNull(userRunes.equippedToUid),
      inArray(userRunes.equippedToUid, characterUids),
    )).for("update");
    return rows.length;
  }
}
