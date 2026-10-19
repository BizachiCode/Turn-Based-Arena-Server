// GM chat mute lookup for `ChatService`: reads `users.chat_muted_until` through a short cache so the per-message check
// does not hit the database on every chat line.

import type { Clock } from "../../shared/kernel/clock.js";
import type { ChatMuteSource } from "./chat.ports.js";

/** How long a lookup is trusted. Another server process may mute a player; this bounds how late it takes effect. */
const CACHE_TTL_MS = 15_000;
/** Above this many entries the expired ones are dropped on the next write. */
const PRUNE_ABOVE = 10_000;

export class CachedGmMuteSource {
  private readonly entries = new Map<string, { untilUnix: number; expiresAtMs: number }>();

  constructor(
    /** End of the player's GM mute (null when not muted). */
    private readonly load: (userId: string) => Promise<Date | null>,
    private readonly clock: Clock,
  ) {}

  /** Unix seconds until which the player is muted (0 = not muted). */
  readonly untilUnix: ChatMuteSource = async (userId) => {
    const now = this.clock.nowMs();
    const hit = this.entries.get(userId);
    if (hit && hit.expiresAtMs > now) return hit.untilUnix;

    const until = await this.load(userId);
    const untilUnix = until ? Math.floor(until.getTime() / 1000) : 0;
    if (this.entries.size >= PRUNE_ABOVE) this.prune(now);
    this.entries.set(userId, { untilUnix, expiresAtMs: now + CACHE_TTL_MS });
    return untilUnix;
  };

  /** Call after a mute/unmute so this process sees it immediately. */
  invalidate(userId: string): void {
    this.entries.delete(userId);
  }

  private prune(now: number): void {
    for (const [userId, entry] of this.entries) if (entry.expiresAtMs <= now) this.entries.delete(userId);
  }
}
