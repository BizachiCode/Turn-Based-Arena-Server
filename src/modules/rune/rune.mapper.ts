// src/modules/rune/rune.mapper.ts

import type { RuneDto, RuneSearchItemDto, RuneSyncDto } from "./rune.dto.js";
import type { RuneRecord, Substat } from "./rune.ports.js";

/** Parses the `substats` JSON column (MySQL returns arrays, MariaDB returns strings). */
export function parseSubstats(raw: unknown): Substat[] {
  if (!raw) return [];
  try {
    const value = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? (parsed as Substat[]) : [];
  } catch {
    return [];
  }
}

export function toRuneRecord(row: any): RuneRecord {
  return {
    id: Number(row.id ?? 0),
    uid: String(row.public_uid),
    setId: String(row.set_id),
    slot: Number(row.slot) | 0,
    tier: Number(row.tier) | 0,
    variant: String(row.variant),
    quality: Number(row.quality) | 0,
    level: Number(row.level) | 0,
    mainStatType: String(row.main_stat_type),
    mainStatValue: Number(row.main_stat_value) | 0,
    substats: parseSubstats(row.substats),
    origin: row.origin ?? null,
    locked: Number(row.locked ?? 0) === 1,
    favorite: Number(row.favorite ?? 0) === 1,
    equippedToUid: row.equipped_to_uid ?? null,
    equippedAt: row.equipped_at ? new Date(row.equipped_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

export function toRuneSyncDto(rune: Pick<RuneRecord, "uid" | "setId" | "slot" | "tier" | "variant" | "quality" | "level" | "mainStatType" | "mainStatValue" | "substats" | "origin"> & Partial<RuneRecord>): RuneSyncDto {
  return {
    uid: rune.uid,
    setId: rune.setId,
    slot: rune.slot,
    tier: rune.tier,
    variant: rune.variant,
    quality: rune.quality,
    level: rune.level,
    mainStatType: rune.mainStatType,
    mainStatValue: rune.mainStatValue,
    substats: rune.substats,
    origin: rune.origin ?? null,
    locked: rune.locked ? 1 : 0,
    favorite: rune.favorite ? 1 : 0,
    equippedToUid: rune.equippedToUid ?? null,
  };
}

export function toRuneSearchItem(rune: RuneRecord): RuneSearchItemDto {
  return {
    id: rune.id,
    ...toRuneSyncDto(rune),
    equippedAt: rune.equippedAt ? rune.equippedAt.toISOString() : null,
    createdAt: rune.createdAt ? rune.createdAt.toISOString() : null,
  };
}

/** Battle-core view of a rune. */
export function toRuneDto(rune: RuneRecord): RuneDto {
  return {
    uid: rune.uid,
    setId: rune.setId,
    slot: rune.slot,
    tier: rune.tier,
    variant: rune.variant,
    quality: rune.quality,
    level: rune.level,
    mainStatType: rune.mainStatType,
    mainStatValue: rune.mainStatValue,
    substats: rune.substats,
    origin: rune.origin,
    locked: rune.locked,
    favorite: rune.favorite,
    equippedToUid: rune.equippedToUid,
    equippedAt: rune.equippedAt ? rune.equippedAt.toISOString() : null,
    createdAtIso: rune.createdAt ? rune.createdAt.toISOString() : null,
  };
}
