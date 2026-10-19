// src/modules/rune/rune.dto.ts
// Rune shapes parsed by the Unity client.

import type { Substat } from "./rune.ports.js";

/** Rune substat (also consumed by battle-core). */
export type SubstatDto = Substat;

/**
 * Full rune view consumed by battle-core (`buildPlayerBattleStats`). Keep this shape stable:
 * battle-core and its tests import it.
 */
export interface RuneDto {
  uid: string;
  setId: string;
  slot: number;
  tier: number;
  variant: string;
  quality: number;
  level: number;
  mainStatType: string;
  mainStatValue: number;
  substats: SubstatDto[];
  origin: string | null;
  locked: boolean;
  favorite: boolean;
  equippedToUid: string | null;
  equippedAt: string | null;
  createdAtIso: string | null;
}

/** `ServerRuneDTO` on the client (flags as 0/1 numbers). Used by upgrades, grants, rewards and shop. */
export interface RuneSyncDto {
  uid: string;
  setId: string;
  slot: number;
  tier: number;
  variant: string;
  quality: number;
  level: number;
  mainStatType: string;
  mainStatValue: number;
  substats: Substat[];
  origin: string | null;
  locked: number;
  favorite: number;
  equippedToUid: string | null;
}

/** `runes/search` item: a {@link RuneSyncDto} plus its paging `id` and dates (client `RuneSearchItemDTO`). */
export interface RuneSearchItemDto extends RuneSyncDto {
  /** Database id; the last one of a page is the `lastId` of the next page. */
  id: number;
  equippedAt: string | null;
  createdAt: string | null;
}

/** `runes/counts` item (unequipped runes per set). */
export interface RuneSetCountDto {
  setId: string;
  freeCount: number;
}

export interface RuneUpgradeResultDto {
  success: boolean;
  rune: RuneSyncDto;
  spend: number;
  currencyId: string;
  wallet: Record<string, number>;
  walletAfter: number | null;
  /** Present (true) when this is the stored response of a repeated `requestId`. */
  replayed?: true;
}

export interface RuneSellResultDto {
  removedUid: string;
  currencyId: string;
  gained: number;
  wallet: Record<string, number>;
  walletAfter: number;
}
