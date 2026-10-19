import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { RuneCatalog, RuneSubstatRoll } from "../../config/RuneCatalog.js";

export type Substat = {
  stat: string;
  value: number;
  grind?: number;
  gem?: boolean;
};

/** One owned rune (`user_runes`). */
export type RuneRecord = {
  id: number;
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
  locked: boolean;
  favorite: boolean;
  equippedToUid: string | null;
  equippedAt: Date | null;
  createdAt: Date | null;
};

/** Fields required to persist a newly generated rune. */
export type NewRune = Omit<RuneRecord, "id" | "locked" | "favorite" | "equippedToUid" | "equippedAt" | "createdAt">;

export type RuneSearchFilters = {
  setId?: string | null;
  slot?: number | null;
  qMin?: number | null;
  qMax?: number | null;
  lMin?: number | null;
  lMax?: number | null;
  equipped?: boolean | null;
  equippedTo?: string | null;
  lastId?: number | null;
  pageSize: number;
};

/** Persistence port for runes. */
export interface RuneRepository {
  search(userId: string, filters: RuneSearchFilters): Promise<RuneRecord[]>;
  /** Count of unequipped runes per set. */
  freeCountsBySet(userId: string): Promise<Array<{ setId: string; count: number }>>;
  /** Ensures the capacity row exists, locks it, and returns capacity + current count. */
  lockCapacity(userId: string, defaultCapacity: number, session: DbSession): Promise<{ capacity: number; count: number }>;
  insertRune(userId: string, rune: NewRune, session: DbSession): Promise<void>;
  find(userId: string, uid: string, session?: DbSession, forUpdate?: boolean): Promise<RuneRecord | null>;
  listEquippedOn(userId: string, characterUids: string[], session?: DbSession): Promise<RuneRecord[]>;
  updateProgress(userId: string, uid: string, level: number, mainStatValue: number, substats: Substat[], session: DbSession): Promise<void>;
  delete(userId: string, uid: string, session: DbSession): Promise<number>;
  setFlags(userId: string, uid: string, flags: { locked?: boolean; favorite?: boolean }): Promise<number>;
  characterExists(userId: string, characterUid: string, session: DbSession): Promise<boolean>;
  /** Unequips whatever rune `characterUid` wears in `slot`. */
  clearSlot(userId: string, characterUid: string, slot: number, session: DbSession): Promise<number>;
  setEquipped(userId: string, uid: string, characterUid: string | null, session: DbSession): Promise<number>;
}

/** Rune rules exported from Unity (`runes/*.json`). */
export interface RuneRules {
  catalog(): RuneCatalog;
  isMainStatAllowed(slot: number, stat: string): boolean;
  mainStatValue(stat: string, tier: number, variant: string, level: number): number;
  substatRoll(stat: string, tier: number, variant: string): RuneSubstatRoll | undefined;
  upgradeSuccessChance(currentLevel: number): number;
  upgradeCost(currentLevel: number): number;
  upgradeCurrencyId(): string;
}
