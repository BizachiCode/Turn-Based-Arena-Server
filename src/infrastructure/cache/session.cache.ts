// src/infrastructure/cache/session.cache.ts
// Redis-backed active session store (one session per user + device).

import type Redis from "ioredis";
import type { SessionData, SessionStore } from "../../shared/security/session-store.js";

export class RedisSessionStore implements SessionStore {
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: Redis,
    accessTtlMinutes: number,
  ) {
    this.ttlSeconds = Math.max(60, accessTtlMinutes * 60);
  }

  private sessionKey(userId: string, deviceId: string): string {
    return `session:${userId}:${deviceId}`;
  }

  private indexKey(userId: string): string {
    return `session_index:${userId}`;
  }

  async setSession(userId: string, deviceId: string, data: SessionData): Promise<void> {
    const tx = this.redis.multi();
    tx.setex(this.sessionKey(userId, deviceId), this.ttlSeconds, JSON.stringify(data));
    tx.sadd(this.indexKey(userId), deviceId);
    tx.expire(this.indexKey(userId), this.ttlSeconds);
    await tx.exec();
  }

  async getSession(userId: string, deviceId: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.sessionKey(userId, deviceId));
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  async deleteSession(userId: string, deviceId: string): Promise<void> {
    const tx = this.redis.multi();
    tx.del(this.sessionKey(userId, deviceId));
    tx.srem(this.indexKey(userId), deviceId);
    tx.expire(this.indexKey(userId), this.ttlSeconds);
    await tx.exec();
  }

  async deleteAllSessions(userId: string): Promise<void> {
    const deviceIds = await this.redis.smembers(this.indexKey(userId));
    const tx = this.redis.multi();
    for (const deviceId of deviceIds) {
      tx.del(this.sessionKey(userId, deviceId));
    }
    tx.del(this.indexKey(userId));
    await tx.exec();
  }

  async deleteSessionsExcept(userId: string, keepDeviceId: string): Promise<string[]> {
    const deviceIds = (await this.redis.smembers(this.indexKey(userId))).filter((deviceId) => deviceId !== keepDeviceId);
    if (deviceIds.length === 0) return [];
    const tx = this.redis.multi();
    for (const deviceId of deviceIds) {
      tx.del(this.sessionKey(userId, deviceId));
      tx.srem(this.indexKey(userId), deviceId);
    }
    await tx.exec();
    return deviceIds;
  }

  async touchSession(userId: string, deviceId: string): Promise<void> {
    const tx = this.redis.multi();
    tx.expire(this.sessionKey(userId, deviceId), this.ttlSeconds);
    tx.expire(this.indexKey(userId), this.ttlSeconds);
    await tx.exec();
  }
}
