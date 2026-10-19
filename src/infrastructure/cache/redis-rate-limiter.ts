// src/infrastructure/cache/redis-rate-limiter.ts
// Token bucket shared by every server process (Redis Lua script = atomic read-refill-consume).

import type Redis from "ioredis";
import type { RateLimiter, TokenBucketOptions } from "../../shared/security/rate-limiter.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("RateLimiter");

// KEYS[1] bucket; ARGV: capacity, tokens per ms, ttl ms. Uses the Redis clock so every instance agrees on time.
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(data[1]) or capacity
local last = tonumber(data[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - last) * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'l', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return allowed
`;

/**
 * Redis-backed {@link RateLimiter}: same token-bucket semantics as {@link TokenBucketRateLimiter}, but the state is
 * shared by every process (required behind a load balancer). Fails open (allows) when Redis is unreachable, so a
 * cache outage never locks every player out; the error is logged.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly capacity: number;
  private readonly tokensPerMs: number;
  private readonly ttlMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    options: TokenBucketOptions,
  ) {
    this.capacity = Math.max(1, options.burst ?? options.tokensPerInterval);
    this.tokensPerMs = options.tokensPerInterval / options.intervalMs;
    // An idle bucket is full again after capacity / rate ms; keep it a bit longer, then let Redis drop it.
    this.ttlMs = Math.ceil(this.capacity / this.tokensPerMs) + 1_000;
  }

  async allow(key: string): Promise<boolean> {
    try {
      const result = await this.redis.eval(TOKEN_BUCKET_LUA, 1, `rl:${this.name}:${key}`, this.capacity, this.tokensPerMs, this.ttlMs);
      return Number(result) === 1;
    } catch (error) {
      logger.warn(`redis unavailable, allowing request (${this.name}):`, (error as Error).message);
      return true;
    }
  }
}
