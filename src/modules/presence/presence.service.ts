import type { PresenceConnection, PresenceRepository } from "./presence.ports.js";

/** `user_sessions` rows (one per connection) are kept this long after their last heartbeat; the DAU analytics read them. */
export const SESSION_RETENTION_DAYS = 45;
/** Rows deleted per statement, and statements per prune run (bounds the work of one run: 20 000 rows). */
const PRUNE_BATCH = 1_000;
const PRUNE_MAX_BATCHES = 20;
const DAY_MS = 86_400_000;

export type PresenceServiceOptions = {
  retentionDays?: number;
  now?: () => number;
};

export class PresenceService {
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(private readonly repo: PresenceRepository, options: PresenceServiceOptions = {}) {
    this.retentionMs = Math.max(1, options.retentionDays ?? SESSION_RETENTION_DAYS) * DAY_MS;
    this.now = options.now ?? Date.now;
  }

  registerConnection(connection: PresenceConnection): Promise<void> {
    return this.repo.upsertSession(connection);
  }

  unregisterConnection(sessionId: string): Promise<void> {
    return this.repo.markDisconnected(sessionId);
  }

  touch(sessionId: string): Promise<void> {
    return this.repo.touchSession(sessionId);
  }

  getOnlineCount(): Promise<number> {
    return this.repo.countOnline();
  }

  /**
   * Deletes the connection rows older than the retention window (every connection inserts one row, nothing else removes
   * them). Bounded per run; safe to run from several rooms / processes at once. Returns the rows removed.
   */
  async pruneSessions(): Promise<number> {
    const before = new Date(this.now() - this.retentionMs);
    let total = 0;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
      const removed = await this.repo.deleteStaleSessions(before, PRUNE_BATCH);
      total += removed;
      if (removed < PRUNE_BATCH) break;
    }
    return total;
  }
}
