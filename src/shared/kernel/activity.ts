// Player activity events (stage clears, arena battles, summons...) published by the gameplay services AFTER their
// transaction committed, and consumed by progress features such as the guild quests. Publishing never fails the
// caller: listener errors are logged and swallowed.

import { createLogger } from "../logger.js";

/**
 * Counted actions: the guild quest kinds of `guild.json` and the mission kinds of `missions.json`. `amount` is a count,
 * except for `account_level` (the level reached) and `energy_spent` (energy paid).
 */
export type PlayerActivityKind =
  | "stage_clear"
  | "arena_battle"
  | "summon"
  | "rune_upgrade"
  | "monster_powerup"
  | "dungeon_clear"
  | "energy_spent"
  | "monster_evolve"
  | "monster_awaken"
  | "account_level"
  | "tower_clear";

export interface PlayerActivitySink {
  /** Records `amount` actions of `kind` for the player. Never rejects. */
  record(userId: string, kind: PlayerActivityKind, amount?: number): Promise<void>;
}

export interface PlayerActivityListener {
  onActivity(userId: string, kind: PlayerActivityKind, amount: number): Promise<void>;
}

/** Sink that drops events (tests, services built without listeners). */
export const noActivity: PlayerActivitySink = { record: async () => undefined };

const logger = createLogger("PlayerActivity");

/** Fan-out sink: services publish to it, features subscribe later (composition root). */
export class PlayerActivityHub implements PlayerActivitySink {
  private readonly listeners: PlayerActivityListener[] = [];

  subscribe(listener: PlayerActivityListener): void {
    this.listeners.push(listener);
  }

  async record(userId: string, kind: PlayerActivityKind, amount = 1): Promise<void> {
    if (!(amount > 0)) return;
    for (const listener of this.listeners) {
      try {
        await listener.onActivity(userId, kind, Math.floor(amount));
      } catch (error) {
        logger.warn(`activity listener failed (${kind}):`, (error as Error).message);
      }
    }
  }
}
