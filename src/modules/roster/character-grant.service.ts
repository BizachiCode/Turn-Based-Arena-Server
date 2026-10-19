// Creates characters for a player inside the caller's transaction (summons, shop packs, GM grants).

import { ulid } from "ulid";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { CharacterDTO } from "../../config/DTO/characterCatalogDto.js";
import type { MonsterProgression } from "../progression/progression.rules.js";
import type { CapacityDefaults, CharacterRecord, CharacterRepository, Location } from "./roster.ports.js";

/** Character definitions exported from Unity (`characters.json`). */
export interface CharacterRules {
  get(characterId: string): CharacterDTO | undefined;
}

export type CharacterGrant = {
  characterId: string;
  stars?: number;
  level?: number;
  currentExp?: number;
  awakeningIndex?: number;
};

export class CharacterGrantService {
  constructor(
    private readonly characters: CharacterRepository,
    private readonly rules: CharacterRules,
    private readonly progression: MonsterProgression,
    private readonly capacityDefaults: CapacityDefaults,
  ) {}

  /** Free slots at `location` (locks the capacity row). */
  async freeSlots(session: DbSession, userId: string, location: Location): Promise<number> {
    const caps = await this.characters.getCapacity(userId, this.capacityDefaults(), session, true);
    const counts = await this.characters.getCounts(userId, session, true);
    return location === "STORAGE"
      ? Math.max(0, caps.storageCapacity - counts.storageCount)
      : Math.max(0, caps.bagCapacity - counts.bagCount);
  }

  /**
   * Inserts the characters at `location`. Throws `ROSTER_CAPACITY_FULL` (or `fullError`) when they
   * don't fit and `CHAR_NOT_IN_CATALOG` for unknown ids.
   */
  async grant(session: DbSession, userId: string, grants: CharacterGrant[], location: Location, fullError: string = ErrorCode.ROSTER_CAPACITY_FULL): Promise<CharacterRecord[]> {
    if (grants.length === 0) return [];
    if ((await this.freeSlots(session, userId, location)) < grants.length) {
      throw new AppError(fullError, { fields: { target: location } });
    }

    const created: CharacterRecord[] = [];
    for (const grant of grants) {
      const definition = this.rules.get(grant.characterId);
      if (!definition) throw new AppError("CHAR_NOT_IN_CATALOG", { extra: { characterId: grant.characterId } });

      const stars = clampInt(grant.stars ?? definition.naturalStars ?? 1, 1, 6);
      const level = clampInt(grant.level ?? 1, 1, this.progression.maxLevelForStars(stars));
      const awakeningIndex = Math.max(0, Math.floor(grant.awakeningIndex ?? 0));
      const record: CharacterRecord = {
        uid: ulid(),
        characterId: definition.id,
        stars,
        level,
        currentExp: Math.max(0, Math.floor(grant.currentExp ?? 0)),
        awakeningIndex,
        skillLevels: skillIdsOf(definition).map(() => 1),
        locked: false,
        location,
        createdAt: new Date(),
      };

      await this.characters.insertCharacter(userId, record, session);
      created.push(record);
    }

    return created;
  }
}

function skillIdsOf(definition: CharacterDTO): string[] {
  if (Array.isArray(definition.skillIds) && definition.skillIds.length > 0) return definition.skillIds;
  return Array.isArray(definition.skills) ? definition.skills.map((skill) => skill.id) : [];
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}
