// Read-through cache entries that cannot be poisoned by a stale write.
//
// Race this closes: a reader misses, reads the database, a mutation commits and invalidates, then the reader writes
// its (now stale) page back and keeps serving it until the TTL expires. Here every scope (usually one user) has a
// version token; `bump` replaces it, readers take the token BEFORE they query the database and store it with the
// entry, and `get` only returns entries whose token is still the current one. A late stale write is therefore
// ignored by every reader, with no need for atomic compare-and-set in the cache backend.

import type { KeyValueCache } from "./cache.js";

/** The version key must outlive every entry TTL (and the longest database read) so an expired token cannot revive a stale entry. */
const VERSION_TTL_SECONDS = 3600;
const NO_VERSION = "0";

type Entry<T> = { t: string; v: T };

let counter = 0;
const newToken = () => `${Date.now().toString(36)}.${(counter++).toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

export class VersionedCache {
  constructor(
    private readonly cache: KeyValueCache,
    /** Prefix of the version keys, e.g. `roster_ver`. */
    private readonly versionPrefix: string,
  ) {}

  /** Current token of the scope. Call it before reading the data from the database. */
  async token(scope: string): Promise<string> {
    return (await this.cache.get<string>(`${this.versionPrefix}:${scope}`)) ?? NO_VERSION;
  }

  async get<T>(key: string, scope: string): Promise<T | null> {
    const [entry, current] = await Promise.all([this.cache.get<Entry<T>>(key), this.token(scope)]);
    return entry && entry.t === current ? entry.v : null;
  }

  /** Stores the value under the token read before the database query; stale tokens are rejected by `get`. */
  set(key: string, value: unknown, ttlSeconds: number, token: string): Promise<void> {
    return this.cache.set(key, { t: token, v: value } satisfies Entry<unknown>, ttlSeconds);
  }

  /** Invalidates the scope: new token (stale in-flight writes become invisible) and the listed keys removed. */
  async bump(scope: string, ...keys: string[]): Promise<void> {
    await this.cache.set(`${this.versionPrefix}:${scope}`, newToken(), VERSION_TTL_SECONDS);
    if (keys.length > 0) await this.cache.delete(...keys);
  }
}
