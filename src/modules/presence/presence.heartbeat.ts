/**
 * The Unity client sends `hb` every 15 s. Each heartbeat re-checks the session and writes `user_sessions`, so anything
 * faster than this is a flood (or a broken client) and is ignored instead of hitting Redis and the database.
 */
export const HEARTBEAT_MIN_INTERVAL_MS = 2_000;

/** Per-connection minimum spacing between accepted heartbeats. */
export class HeartbeatGate {
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly minIntervalMs: number = HEARTBEAT_MIN_INTERVAL_MS) {}

  /** True when the heartbeat at `nowMs` must be processed; false when it arrived too soon after the last accepted one. */
  accept(nowMs: number): boolean {
    if (nowMs - this.lastAcceptedAt < this.minIntervalMs) return false;
    this.lastAcceptedAt = nowMs;
    return true;
  }
}
