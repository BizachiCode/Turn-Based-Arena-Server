/**
 * Best-effort key/value cache port. Implementations must never throw: a cache outage degrades to
 * cache misses, never to failed requests.
 */
export interface KeyValueCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(...keys: string[]): Promise<void>;
}

/** Cache that stores nothing (tests, cache disabled). */
export const noCache: KeyValueCache = {
  get: async <T>(): Promise<T | null> => null,
  set: async (): Promise<void> => undefined,
  delete: async (): Promise<void> => undefined,
};

/** Simple in-memory cache (tests, single-process setups). */
export class InMemoryCache implements KeyValueCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }
}
