// Per-account cap on simultaneous room connections. A normal client keeps ~21 rooms open (one per room type) and may be
// signed in on two devices, so the defaults leave room for that (see MAX_CONNECTIONS_PER_USER in docs/SECURITY.md); a script
// opening hundreds of rooms with one token is refused. Counters are per process (the registry is in memory).

export type ConnectionLimits = {
  /** Connections of one account across every room (0 = unlimited). */
  maxPerUser: number;
  /** Connections of one account to the same room type, e.g. `battle_pve` (0 = unlimited). */
  maxPerRoomType: number;
};

export class ConnectionRegistry {
  private readonly sessions = new Map<string, { userId: string; roomName: string }>();
  private readonly users = new Map<string, { total: number; perRoom: Map<string, number> }>();

  constructor(private limits: ConnectionLimits = { maxPerUser: 0, maxPerRoomType: 0 }) {}

  configure(limits: ConnectionLimits): void {
    this.limits = limits;
  }

  /** Registers a connection; false (nothing registered) when it would exceed a limit. */
  tryAcquire(sessionKey: string, userId: string, roomName: string): boolean {
    if (this.sessions.has(sessionKey)) return true;
    const entry = this.users.get(userId) ?? { total: 0, perRoom: new Map<string, number>() };
    const inRoom = entry.perRoom.get(roomName) ?? 0;
    if (this.limits.maxPerUser > 0 && entry.total >= this.limits.maxPerUser) return false;
    if (this.limits.maxPerRoomType > 0 && inRoom >= this.limits.maxPerRoomType) return false;
    entry.total++;
    entry.perRoom.set(roomName, inRoom + 1);
    this.users.set(userId, entry);
    this.sessions.set(sessionKey, { userId, roomName });
    return true;
  }

  /** Releases a connection (no-op for unknown keys, e.g. a join that was refused). */
  release(sessionKey: string): void {
    const info = this.sessions.get(sessionKey);
    if (!info) return;
    this.sessions.delete(sessionKey);
    const entry = this.users.get(info.userId);
    if (!entry) return;
    entry.total--;
    const left = (entry.perRoom.get(info.roomName) ?? 1) - 1;
    if (left > 0) entry.perRoom.set(info.roomName, left);
    else entry.perRoom.delete(info.roomName);
    if (entry.total <= 0) this.users.delete(info.userId);
  }

  countOf(userId: string): number {
    return this.users.get(userId)?.total ?? 0;
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Process-wide registry used by every bound room; unlimited until the composition root configures it. */
export const connectionRegistry = new ConnectionRegistry();

export function configureConnectionLimits(limits: ConnectionLimits): void {
  connectionRegistry.configure(limits);
}
