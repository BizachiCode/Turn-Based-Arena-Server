// Online / in battle / offline of players: presence connections (`user_sessions`) plus the live battle registry.

import type { Clock } from "../../shared/kernel/clock.js";
import { OFFLINE, toUnix, type PlayerStatusInfo } from "./social.domain.js";
import type { PlayerDirectory } from "./social.ports.js";

/** The live battles of several players (`ActiveBattleRegistry.findMany`). */
export type ActiveBattleLookup = { findMany(userIds: readonly string[]): Promise<Map<string, unknown>> };

export class PlayerStatusReader {
  constructor(
    private readonly directory: Pick<PlayerDirectory, "connectionsOf">,
    private readonly battles: ActiveBattleLookup,
    private readonly clock: Clock,
    /** A heartbeat at most this old counts as online (`social.json > friends.onlineWindowSeconds`). */
    private readonly onlineWindowSeconds: () => number,
  ) {}

  /**
   * Status of every player: `in_battle` while a battle room holds their slot (also during a reconnection window),
   * `online` with a live presence connection, `offline` otherwise (with the last heartbeat).
   */
  async statusOf(userIds: readonly string[]): Promise<Map<string, PlayerStatusInfo>> {
    const ids = [...new Set(userIds)];
    const result = new Map<string, PlayerStatusInfo>();
    if (ids.length === 0) return result;
    const since = new Date(this.clock.nowMs() - this.onlineWindowSeconds() * 1000);
    const [connections, battles] = await Promise.all([
      this.directory.connectionsOf(ids, since),
      this.battles.findMany(ids).catch(() => new Map<string, unknown>()),
    ]);
    for (const userId of ids) {
      const connection = connections.get(userId);
      if (battles.has(userId)) result.set(userId, { status: "in_battle", lastSeenUnix: null });
      else if (connection?.online) result.set(userId, { status: "online", lastSeenUnix: null });
      else result.set(userId, connection?.lastSeenAt ? { status: "offline", lastSeenUnix: toUnix(connection.lastSeenAt) } : OFFLINE);
    }
    return result;
  }

  async statusOne(userId: string): Promise<PlayerStatusInfo> {
    return (await this.statusOf([userId])).get(userId) ?? OFFLINE;
  }
}
