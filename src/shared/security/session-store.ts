/** Cached server-side session (one per user + device). Revoking it kicks the device. */
export type SessionData = {
  username: string;
  level: number;
  nickname: string;
  iconId: string | null;
  accessJti: string;
};

/** Port for the active-session store (Redis in production, in-memory in tests). */
export interface SessionStore {
  setSession(userId: string, deviceId: string, data: SessionData): Promise<void>;
  getSession(userId: string, deviceId: string): Promise<SessionData | null>;
  deleteSession(userId: string, deviceId: string): Promise<void>;
  deleteAllSessions(userId: string): Promise<void>;
  /** Deletes every session of the user except `keepDeviceId`; returns the device ids that were removed. */
  deleteSessionsExcept(userId: string, keepDeviceId: string): Promise<string[]>;
  touchSession(userId: string, deviceId: string): Promise<void>;
}
