// src/modules/roster/roster.dto.ts
// Data Transfer Objects for the roster module (shapes parsed by the Unity client).

import type { WalletSnapshot } from "../../shared/kernel/types.js";

/** Character as sent to the client (`ServerCharDTO` + createdAtIso). */
export interface CharacterDto {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  currentExp: number;
  awakened: boolean;
  awakeningIndex: number;
  skillLevels: number[];
  /** Locked monsters cannot be consumed as fodder or sold. */
  locked: boolean;
  createdAtIso: string | null;
}

export interface RosterListResultDto {
  total: number;
  items: CharacterDto[];
  nextOffset: number | null;
}

export interface StorageListResultDto {
  storage: CharacterDto[];
  total: number;
}

export interface StorageCapsResultDto {
  bagCapacity: number;
  storageCapacity: number;
  bagCount: number;
  storageCount: number;
}

export interface StorageMoveResultDto extends StorageCapsResultDto {
  target: "BAG" | "STORAGE";
  moved: number;
  movedUids: string[];
}

export interface PowerUpResultDto {
  targetUid: string;
  currencyId: string;
  priceSpent: number;
  expAdded: number;
  levelsGained: number;
  newLevel: number;
  newCurrentExp: number;
  removedFodders: string[];
  /** One entry per skill-up granted by this power-up (same monster / skill-up material fodders). */
  skillUps: Array<{ skillIndex: number; skillId: string; level: number }>;
  /** Skill levels of the target after the power-up. */
  skillLevels: number[];
  /** Present (true) when this is the stored response of a repeated `requestId`. */
  replayed?: true;
}

export interface LockResultDto {
  uid: string;
  locked: boolean;
}

export interface SellResultDto {
  soldUids: string[];
  currencyId: string;
  amount: number;
  wallet: WalletSnapshot;
  replayed?: true;
}

export interface ExpandResultDto {
  target: "BAG" | "STORAGE";
  bagCapacity: number;
  storageCapacity: number;
  currencyId: string;
  priceSpent: number;
  wallet: WalletSnapshot;
  replayed?: true;
}

export interface EvolveResultDto {
  targetUid: string;
  newStars: number;
  resetLevelTo: number;
  resetExpTo: number;
  starPointsSpent: number;
  currencyId: string;
  priceSpent: number;
  removedFodders: string[];
  replayed?: true;
}
