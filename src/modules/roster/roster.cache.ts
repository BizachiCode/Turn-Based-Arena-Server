// src/modules/roster/roster.cache.ts
// Read-through cache for the first BAG page and the capacity numbers (invalidated on mutations).
// Entries carry the user's version token (see VersionedCache): a read that raced a mutation cannot re-cache stale data.

import type { KeyValueCache } from "../../shared/kernel/cache.js";
import { VersionedCache } from "../../shared/kernel/versioned-cache.js";
import type { CharacterDto, StorageCapsResultDto } from "./roster.dto.js";

const ROSTER_TTL_SECONDS = 600;
const CAPS_TTL_SECONDS = 300;

export type CachedRosterPage = { total: number; items: CharacterDto[] };

export class RosterCache {
  private readonly versioned: VersionedCache;

  constructor(cache: KeyValueCache) {
    this.versioned = new VersionedCache(cache, "roster_ver");
  }

  /** Version token to read BEFORE querying the database and to pass to the `set*` calls. */
  token(userId: string): Promise<string> {
    return this.versioned.token(userId);
  }

  getRoster(userId: string): Promise<CachedRosterPage | null> {
    return this.versioned.get<CachedRosterPage>(`roster:${userId}`, userId);
  }

  setRoster(userId: string, page: CachedRosterPage, token: string): Promise<void> {
    return this.versioned.set(`roster:${userId}`, page, ROSTER_TTL_SECONDS, token);
  }

  getCaps(userId: string): Promise<StorageCapsResultDto | null> {
    return this.versioned.get<StorageCapsResultDto>(`roster_caps:${userId}`, userId);
  }

  setCaps(userId: string, caps: StorageCapsResultDto, token: string): Promise<void> {
    return this.versioned.set(`roster_caps:${userId}`, caps, CAPS_TTL_SECONDS, token);
  }

  /** Call after any roster mutation (move, power-up, evolve, awaken, summon, rewards). */
  invalidate(userId: string): Promise<void> {
    return this.versioned.bump(userId, `roster:${userId}`, `roster_caps:${userId}`);
  }
}
