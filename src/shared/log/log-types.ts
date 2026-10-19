// Types shared by the log sink, its persistence adapter and the GM panel read model.

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** What the terminal prints: nothing, errors only, or everything (the classic console output). */
export type LogConsoleMode = "none" | "error" | "all";

/** Who/where an entry is about (all optional). */
export type LogContext = {
  userId?: string | null;
  /** Colyseus room name the entry came from. */
  room?: string | null;
};

/** One entry as kept in the ring buffer and handed to the store. */
export type LogEntry = {
  /** In-process sequence number (monotonic, restarts with the process). */
  seq: number;
  /** Epoch milliseconds. */
  time: number;
  level: LogLevel;
  /** The "[Tag]" prefix of the message (the logger scope); `console` when the message had none. */
  scope: string;
  message: string;
  /** Stack trace and/or extra arguments. */
  details: string | null;
  userId: string | null;
  room: string | null;
  /** Identical consecutive entries folded into this one. */
  repeats: number;
  pid: number;
  /** False for entries about the sink itself (never written to the database). */
  persist: boolean;
};

/** Row handed to the persistence adapter. */
export type LogRecord = Omit<LogEntry, "seq" | "persist">;

/** Persistence port of the sink (Drizzle adapter under src/infrastructure/logging). */
export interface LogStore {
  insertMany(records: readonly LogRecord[]): Promise<void>;
}

/** Parses LOG_CONSOLE (`none` | `error` | `all`; unknown values fall back to `none`). */
export function parseLogConsoleMode(raw: string | undefined | null): LogConsoleMode {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "all" || value === "error" || value === "none" ? value : "none";
}

/** Parses LOG_LEVEL (the minimum level that enters the sink; default `info`). */
export function parseLogLevel(raw: string | undefined | null): LogLevel {
  const value = String(raw ?? "").trim().toLowerCase() as LogLevel;
  return LOG_LEVEL_ORDER[value] ? value : "info";
}
