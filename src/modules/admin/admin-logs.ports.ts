// GM panel "Logs": read model over the server log entries (`server_logs` table, with the sink ring buffer as fallback).

import type { LogLevel } from "../../shared/log/log-types.js";

export type AdminLogQuery = {
  /** Empty = every level. */
  levels: LogLevel[];
  scope: string | null;
  /** Case-insensitive text of the message or the details. */
  q: string | null;
  from: Date | null;
  to: Date | null;
  /** Id of the oldest entry already loaded (entries with a lower id are returned). */
  before: number | null;
  limit: number;
};

export type AdminLogRow = {
  id: number;
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  details: string | null;
  userId: string | null;
  room: string | null;
  /** Identical consecutive entries folded into this one. */
  repeats: number;
  pid: number;
};

export type AdminLogLevelCounts = Record<LogLevel, number>;

export interface AdminLogsRepository {
  /** Newest first. */
  query(query: AdminLogQuery): Promise<AdminLogRow[]>;
  /** Entries per level since `since` (repeats included). */
  levelCounts(since: Date): Promise<AdminLogLevelCounts>;
  /** Scopes seen since `since`, most frequent first. */
  scopes(since: Date, limit: number): Promise<Array<{ scope: string; count: number }>>;
}
