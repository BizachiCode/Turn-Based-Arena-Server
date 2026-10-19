// src/modules/roster/roster.mapper.ts
// Maps persistence rows/records to DTOs.

import type { CharacterDto } from "./roster.dto.js";
import type { CharacterRecord, Location } from "./roster.ports.js";

/** Parses the `skill_levels` JSON column (MySQL returns arrays, MariaDB returns strings). */
export function parseSkillLevels(raw: unknown): number[] {
  try {
    const value = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
    const parsed = typeof value === "string" && value.length > 0 ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed.map((entry) => Number(entry) | 0);
  } catch {
    // fall through to the empty default
  }
  return [];
}

/** Maps a raw `user_characters` row (snake_case columns) to a record. */
export function toCharacterRecord(row: any): CharacterRecord {
  return {
    uid: String(row.public_uid ?? row.id),
    characterId: String(row.character_id),
    stars: Number(row.stars) | 0,
    level: Number(row.level) | 0,
    currentExp: Number(row.current_exp) | 0,
    awakeningIndex: Number(row.awakening_index ?? 0) | 0,
    skillLevels: parseSkillLevels(row.skill_levels),
    locked: Number(row.locked ?? 0) === 1,
    location: (String(row.location ?? "BAG").toUpperCase() === "STORAGE" ? "STORAGE" : "BAG") as Location,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

export function toCharacterDto(record: CharacterRecord): CharacterDto {
  return {
    uid: record.uid,
    characterId: record.characterId,
    stars: record.stars,
    level: record.level,
    currentExp: record.currentExp,
    awakened: record.awakeningIndex > 0,
    awakeningIndex: record.awakeningIndex,
    skillLevels: record.skillLevels,
    locked: record.locked,
    createdAtIso: record.createdAt ? record.createdAt.toISOString() : null,
  };
}

export function toCharacterDtoList(records: CharacterRecord[]): CharacterDto[] {
  return records.map(toCharacterDto);
}
