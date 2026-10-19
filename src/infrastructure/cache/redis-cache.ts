import type Redis from "ioredis";
import type { KeyValueCache } from "../../shared/kernel/cache.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("RedisCache");

/** Redis implementation of {@link KeyValueCache} (JSON values, errors swallowed and logged). */
export class RedisCache implements KeyValueCache {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.setex(key, Math.max(1, Math.floor(ttlSeconds)), JSON.stringify(value));
    } catch (error) {
      logger.warn(`set ${key} failed:`, (error as Error).message);
    }
  }

  async delete(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (error) {
      logger.warn(`delete ${keys.join(",")} failed:`, (error as Error).message);
    }
  }
}
