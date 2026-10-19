// One live battle per player across rooms, devices and processes. Entries live in the Colyseus presence (a Redis
// presence shares them between processes); an entry whose room no longer exists is a zombie (crashed process, missed
// dispose) and is cleared by the next lookup, so it never blocks the player.

import { matchMaker } from "@colyseus/core";

export type ActiveBattleMode = "pve" | "arena" | "pvp";

/** The player's live battle: the room holding it and, once the session is built, its battle id. */
export type ActiveBattle = {
  roomId: string;
  battleId: string | null;
  mode: ActiveBattleMode;
  sinceUnix: number;
};

/** Subset of the Colyseus `Presence` the registry needs. */
export interface ActiveBattleStore {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<boolean>;
  hdel(key: string, field: string): Promise<boolean>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): unknown;
  del(key: string): unknown;
}

/** Whether a room still exists anywhere in the cluster (the matchmaking driver). */
export type RoomExists = (roomId: string) => Promise<boolean> | boolean;

const ENTRIES_KEY = "battle:active";
const LOCK_PREFIX = "battle:claim:";
/** A claim holds its lock for milliseconds; the expiry only matters when a process dies while holding it. */
const LOCK_SECONDS = 10;

function parseEntry(raw: string | null): ActiveBattle | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ActiveBattle>;
    if (typeof value?.roomId !== "string" || !value.roomId) return null;
    return {
      roomId: value.roomId,
      battleId: typeof value.battleId === "string" ? value.battleId : null,
      mode: value.mode === "arena" || value.mode === "pvp" ? value.mode : "pve",
      sinceUnix: Number(value.sinceUnix) || 0,
    };
  } catch {
    return null;
  }
}

/** `active`: the other live battle when the claim was refused (null while another claim of the player is in flight). */
export type ClaimResult = { ok: boolean; active: ActiveBattle | null };

export class ActiveBattleRegistry {
  constructor(
    private readonly store: () => ActiveBattleStore,
    private readonly roomExists: RoomExists,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** The player's live battle (null when none; a zombie entry is cleared). */
  async find(userId: string): Promise<ActiveBattle | null> {
    const entry = parseEntry(await this.store().hget(ENTRIES_KEY, userId));
    if (!entry) return null;
    if (await this.isAlive(entry.roomId)) return entry;
    await this.release(userId, entry.roomId);
    return null;
  }

  /** Live battles of several players (friends list `inBattle`). */
  async findMany(userIds: readonly string[]): Promise<Map<string, ActiveBattle>> {
    const found = await Promise.all(userIds.map(async (userId) => [userId, await this.find(userId)] as const));
    return new Map(found.filter((pair): pair is readonly [string, ActiveBattle] => pair[1] !== null));
  }

  /**
   * Gives the player's battle slot to `roomId`. Refused (`ok: false`) when another live room holds it (`active`), or
   * while another claim of the same player is in flight (`active` null). Claiming again from the same room succeeds.
   */
  async claim(userId: string, roomId: string, mode: ActiveBattleMode): Promise<ClaimResult> {
    const store = this.store();
    const lockKey = `${LOCK_PREFIX}${userId}`;
    const holders = await store.incr(lockKey);
    if (holders !== 1) return { ok: false, active: null };
    await store.expire(lockKey, LOCK_SECONDS);
    try {
      const current = await this.find(userId);
      if (current && current.roomId !== roomId) return { ok: false, active: current };
      const entry: ActiveBattle = { roomId, battleId: current?.battleId ?? null, mode, sinceUnix: Math.floor(this.nowMs() / 1000) };
      await store.hset(ENTRIES_KEY, userId, JSON.stringify(entry));
      return { ok: true, active: null };
    } finally {
      await store.del(lockKey);
    }
  }

  /** Records the battle id of the slot held by `roomId` (no-op when the room no longer holds it). */
  async attachBattle(userId: string, roomId: string, battleId: string): Promise<void> {
    const store = this.store();
    const entry = parseEntry(await store.hget(ENTRIES_KEY, userId));
    if (!entry || entry.roomId !== roomId) return;
    await store.hset(ENTRIES_KEY, userId, JSON.stringify({ ...entry, battleId }));
  }

  /** Frees the slot if `roomId` holds it (a newer battle of the player in another room is left alone). */
  async release(userId: string, roomId: string): Promise<void> {
    const store = this.store();
    const entry = parseEntry(await store.hget(ENTRIES_KEY, userId));
    if (entry && entry.roomId === roomId) await store.hdel(ENTRIES_KEY, userId);
  }

  private async isAlive(roomId: string): Promise<boolean> {
    try {
      return await this.roomExists(roomId);
    } catch {
      // Fail open: a driver hiccup must not wipe a live battle.
      return true;
    }
  }
}

/** Registry over the process-wide Colyseus presence and matchmaking driver (read lazily: set up after the container). */
export function createColyseusActiveBattleRegistry(): ActiveBattleRegistry {
  return new ActiveBattleRegistry(
    () => matchMaker.presence as unknown as ActiveBattleStore,
    (roomId) => matchMaker.driver.has(roomId),
  );
}
