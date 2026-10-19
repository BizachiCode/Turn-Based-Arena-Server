// src/modules/rune/rune.cache.ts
// Cached unequipped-rune counts per set (invalidated on every rune mutation).
// Entries carry the user's version token (see VersionedCache): a read that raced a mutation cannot re-cache stale data.

import type { KeyValueCache } from "../../shared/kernel/cache.js";
import { VersionedCache } from "../../shared/kernel/versioned-cache.js";
import type { RuneSetCountDto } from "./rune.dto.js";

const COUNTS_TTL_SECONDS = 300;

export class RuneCache {
  private readonly versioned: VersionedCache;

  constructor(cache: KeyValueCache) {
    this.versioned = new VersionedCache(cache, "rune_ver");
  }

  /** Version token to read BEFORE querying the database and to pass to `setSetCounts`. */
  token(userId: string): Promise<string> {
    return this.versioned.token(userId);
  }

  getSetCounts(userId: string): Promise<RuneSetCountDto[] | null> {
    return this.versioned.get<RuneSetCountDto[]>(`rune_counts:${userId}`, userId);
  }

  setSetCounts(userId: string, counts: RuneSetCountDto[], token: string): Promise<void> {
    return this.versioned.set(`rune_counts:${userId}`, counts, COUNTS_TTL_SECONDS, token);
  }

  invalidate(userId: string): Promise<void> {
    return this.versioned.bump(userId, `rune_counts:${userId}`);
  }
}
