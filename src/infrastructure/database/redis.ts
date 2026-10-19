// src/infrastructure/database/redis.ts
// Redis client singleton (sessions, caches).

import Redis from "ioredis";
import { env } from "../../config/env.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("Redis");

export const redis = new Redis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  db: env.redis.db,
  keyPrefix: env.redis.keyPrefix,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 5000);
  },
  lazyConnect: true,
});

redis.on("error", (err) => {
  logger.error("connection error:", err.message);
});

redis.on("connect", () => {
  logger.info("connected");
});

/** Graceful shutdown helper. */
export async function disconnectRedis(): Promise<void> {
  await redis.quit().catch((): void => undefined);
}
