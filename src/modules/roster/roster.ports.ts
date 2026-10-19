import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type Location = "BAG" | "STORAGE";

/** One owned character (`user_characters`). */
export type CharacterRecord = {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  currentExp: number;
  awakeningIndex: number;
  skillLevels: number[];
  locked: boolean;
  location: Location;
  createdAt: Date | null;
};

/** Fields required to create a character. */
export type NewCharacter = {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  currentExp: number;
  awakeningIndex: number;
  skillLevels: number[];
  location: Location;
};

export type Capacity = { bagCapacity: number; storageCapacity: number };
export type LocationCounts = { bagCount: number; storageCount: number };

/** Persistence port for player characters and roster capacity. */
export interface CharacterRepository {
  countByLocation(userId: string, location: Location, session?: DbSession): Promise<number>;
  listByLocation(userId: string, location: Location, offset: number, limit: number, session?: DbSession): Promise<CharacterRecord[]>;
  /** Characters owned by `userId` among `uids` (any location). */
  listByUids(userId: string, uids: string[], session?: DbSession): Promise<CharacterRecord[]>;
  /** Same as {@link listByUids} with row locks. */
  lockByUids(userId: string, uids: string[], session: DbSession): Promise<CharacterRecord[]>;
  ownsCharacterId(userId: string, characterId: string, session?: DbSession): Promise<boolean>;

  /** Ensures a capacity row exists and returns it (optionally locked). */
  getCapacity(userId: string, defaults: Capacity, session: DbSession, forUpdate?: boolean): Promise<Capacity>;
  getCounts(userId: string, session: DbSession, forUpdate?: boolean): Promise<LocationCounts>;

  moveCharacters(userId: string, from: Location, to: Location, uids: string[], session: DbSession): Promise<number>;
  updateProgress(userId: string, uid: string, level: number, currentExp: number, session: DbSession): Promise<number>;
  /** Replaces the skill levels (indexed like the character's skills). */
  updateSkillLevels(userId: string, uid: string, skillLevels: number[], session: DbSession): Promise<number>;
  updateLocked(userId: string, uid: string, locked: boolean, session: DbSession): Promise<number>;
  /** Deletes owned characters in any location (selling). */
  deleteCharacters(userId: string, uids: string[], session: DbSession): Promise<number>;
  setCapacity(userId: string, capacity: Capacity, session: DbSession): Promise<void>;
  /** Sets stars and resets level/EXP (evolve). */
  updateStars(userId: string, uid: string, stars: number, session: DbSession): Promise<number>;
  updateAwakening(userId: string, uid: string, awakeningIndex: number, session: DbSession): Promise<number>;
  deleteFromBag(userId: string, uids: string[], session: DbSession): Promise<number>;
  insertCharacter(userId: string, character: NewCharacter, session: DbSession): Promise<void>;

  countEquippedRunes(userId: string, characterUids: string[], session: DbSession): Promise<number>;
}

/** Skills of a character for skill-ups (`characters.json`). */
export interface SkillUpRules {
  /**
   * Skill slots in `skillLevels` order with the skill in that slot at `awakeningIndex` (awakening replacements keep
   * the slot) and its max level (empty = unknown character).
   */
  skills(characterId: string, awakeningIndex: number): Array<{ id: string; maxLevel: number }>;
  /** Fodder that always grants a skill-up whatever the target (skill-up material). */
  isSkillUpMaterial(characterId: string): boolean;
}

/** Units a player keeps in a team setup and must not be consumed or sold (arena defense). */
export interface ReservedUnits {
  reservedUids(userId: string, session?: DbSession): Promise<Set<string>>;
}

export type CapacityExpansionRule = { step: number; currencyId: string; costBase: number; costIncrement: number; initial: number; max: number };

/** Selling and slot purchases (`config.json > gameplay`). */
export type RosterRules = () => {
  sell: { currencyId: string; priceByStars: number[]; pricePerLevel: number };
  expansion: { bag: CapacityExpansionRule; storage: CapacityExpansionRule };
};

/** Roster capacity defaults (`config.json > gameplay.playerCapacity`). */
export type CapacityDefaults = () => Capacity;
