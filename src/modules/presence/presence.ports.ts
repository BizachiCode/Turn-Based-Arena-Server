export type PresenceConnection = {
  sessionId: string;
  userId: string;
  deviceId: string;
  address: string | null;
  userAgent: string | null;
};

/** Persistence port for connection tracking (`user_sessions`). */
export interface PresenceRepository {
  upsertSession(connection: PresenceConnection): Promise<void>;
  markDisconnected(sessionId: string): Promise<void>;
  touchSession(sessionId: string): Promise<void>;
  /** Connections with a heartbeat in the last minute. */
  countOnline(): Promise<number>;
  /**
   * Deletes up to `limit` connection rows whose last heartbeat is older than `before` (closed rows and rows left open by
   * a crashed process alike); returns how many were removed.
   */
  deleteStaleSessions(before: Date, limit: number): Promise<number>;
}
