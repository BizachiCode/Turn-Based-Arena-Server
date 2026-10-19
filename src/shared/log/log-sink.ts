// Log sink: the one place every log line of the server ends up (createLogger, console.*, Colyseus' logger and the
// process-level handlers). It keeps the newest entries in a ring buffer (fast, survives a failing database) and writes
// them to the `server_logs` table in batches. The GM panel "Logs" view reads them back.
//
// Rules this class keeps:
//  - `record()` never blocks and never throws into the caller (logging must not break a request).
//  - Persistence is asynchronous and batched; a failing store backs off and the sink reports it ONCE per minute as a
//    memory-only entry (`persist: false`), so a broken database can never feed itself with log entries (recursion guard).
//  - Floods are aggregated (identical consecutive lines become one entry with `repeats`), capped per second and the
//    pending queue is bounded; what had to be dropped is summarised in a single entry.
//  - The terminal is controlled by `consoleMode` (none | error | all) and uses the ORIGINAL console functions, so the
//    interception installed by `console-capture.ts` can never loop.

import { formatLogArgs, MAX_SCOPE_LENGTH, splitScope } from "./log-format.js";
import { LOG_LEVEL_ORDER, type LogConsoleMode, type LogContext, type LogEntry, type LogLevel, type LogRecord, type LogStore } from "./log-types.js";

/** The console functions the sink prints with (the originals, captured before any interception). */
export type ConsoleOutput = Record<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>;

export type LogSinkOptions = {
  /** Entries kept in memory (default 2000). */
  capacity?: number;
  /** Rows per insert (default 100). */
  batchSize?: number;
  /** How often the pending entries are written (default 1000 ms). */
  flushIntervalMs?: number;
  /** Entries waiting for the store; beyond it new entries stay in memory only (default 5000). */
  maxPending?: number;
  /** An identical entry within this window is folded into the previous one while that one is still pending (default 2000 ms). */
  dedupeWindowMs?: number;
  /** New (non folded) entries accepted per second (default 300). */
  maxPerSecond?: number;
  /** Lowest level that enters the sink (default `info`). */
  minLevel?: LogLevel;
  consoleMode?: LogConsoleMode;
  pid?: number;
  now?: () => number;
  output?: ConsoleOutput;
};

export type LogFilter = {
  levels?: readonly LogLevel[] | null;
  scope?: string | null;
  /** Case-insensitive substring of message / details. */
  q?: string | null;
  fromMs?: number | null;
  toMs?: number | null;
  /** Only entries with a lower sequence number (paging). */
  beforeSeq?: number | null;
  limit?: number;
};

export type LogSinkStats = {
  buffered: number;
  capacity: number;
  pending: number;
  persisted: number;
  dropped: number;
  storeAttached: boolean;
  storeHealthy: boolean;
  lastStoreError: string | null;
  consoleMode: LogConsoleMode;
  minLevel: LogLevel;
};

const STORE_ERROR_REPORT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

function defaultOutput(): ConsoleOutput {
  return {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
}

export class LogSink {
  private capacity: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxPending: number;
  private readonly dedupeWindowMs: number;
  private readonly maxPerSecond: number;
  private readonly pid: number;
  private readonly now: () => number;

  private minLevel: LogLevel;
  private consoleMode: LogConsoleMode;
  private output: ConsoleOutput;

  private readonly ring: LogEntry[] = [];
  private pending: LogEntry[] = [];
  /** Entries already handed to the store (a repeat after that is a new entry). */
  private sealed = new WeakSet<LogEntry>();
  private seq = 0;
  private persistedCount = 0;
  private droppedCount = 0;

  private store: LogStore | null = null;
  private interval: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private storeHealthy = true;
  private lastStoreError: string | null = null;
  private lastStoreErrorReportAt = 0;
  private retryAt = 0;
  private failures = 0;

  private last: { key: string; entry: LogEntry } | null = null;
  private windowStart = 0;
  private windowCount = 0;
  private windowDropped = 0;
  private recording = false;

  constructor(options: LogSinkOptions = {}) {
    this.capacity = Math.max(10, options.capacity ?? 2000);
    this.batchSize = Math.max(1, options.batchSize ?? 100);
    this.flushIntervalMs = Math.max(10, options.flushIntervalMs ?? 1000);
    this.maxPending = Math.max(this.batchSize, options.maxPending ?? 5000);
    this.dedupeWindowMs = Math.max(0, options.dedupeWindowMs ?? 2000);
    this.maxPerSecond = Math.max(1, options.maxPerSecond ?? 300);
    this.minLevel = options.minLevel ?? "info";
    this.consoleMode = options.consoleMode ?? "all";
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.output = options.output ?? defaultOutput();
  }

  // ── Configuration ───────────────────────────────────────────────────

  configure(options: { consoleMode?: LogConsoleMode; minLevel?: LogLevel; capacity?: number }): void {
    if (options.consoleMode) this.consoleMode = options.consoleMode;
    if (options.minLevel) this.minLevel = options.minLevel;
    if (options.capacity) this.capacity = Math.max(10, Math.floor(options.capacity));
  }

  /** Replaces the functions used to print to the terminal (the originals, captured before interception). */
  useOutput(output: ConsoleOutput): void {
    this.output = output;
  }

  getConsoleMode(): LogConsoleMode {
    return this.consoleMode;
  }

  /** Starts persisting: pending entries are written from now on, then every flush interval. */
  attachStore(store: LogStore): void {
    this.store = store;
    this.storeHealthy = true;
    this.retryAt = 0;
    if (!this.interval) {
      this.interval = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.interval.unref?.();
    }
    void this.flush();
  }

  /** Stops the periodic flush (the store stays attached; `flush()` still works). */
  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  // ── Recording ───────────────────────────────────────────────────────

  /**
   * Records one entry from console-style arguments. `scope` null = taken from a leading `[Tag]` of the first argument
   * (`console` when there is none). `consoleArgs` are what the terminal prints (default: `args`). Never throws.
   */
  record(level: LogLevel, scope: string | null, args: readonly unknown[], context?: LogContext, consoleArgs?: readonly unknown[]): void {
    if (this.recording) return;
    this.recording = true;
    try {
      if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) return;
      this.print(level, consoleArgs ?? args);

      let resolvedScope = scope;
      let working = args;
      if (resolvedScope === null && typeof args[0] === "string") {
        const split = splitScope(args[0]);
        if (split.scope) {
          resolvedScope = split.scope;
          working = [split.rest, ...args.slice(1)];
        }
      }
      const { message, details } = formatLogArgs(working);
      this.add({
        level,
        scope: (resolvedScope ?? "console").slice(0, MAX_SCOPE_LENGTH),
        message: message || "(empty)",
        details,
        userId: context?.userId ?? null,
        room: context?.room ?? null,
        persist: true,
      });
    } catch {
      // logging must never break the caller
    } finally {
      this.recording = false;
    }
  }

  /** Records an entry about the sink itself: memory only, so a broken store cannot feed itself. */
  private internal(level: LogLevel, message: string): void {
    this.add({ level, scope: "LogSink", message, details: null, userId: null, room: null, persist: false });
  }

  private add(input: Pick<LogEntry, "level" | "scope" | "message" | "details" | "userId" | "room" | "persist">): void {
    const time = this.now();
    const key = `${input.level}|${input.scope}|${input.message}|${input.userId ?? ""}`;

    // Fold a repeat into the previous entry while it has not been written yet.
    const previous = this.last;
    if (previous && previous.key === key && input.persist && previous.entry.persist &&
      time - previous.entry.time <= this.dedupeWindowMs && !this.sealed.has(previous.entry)) {
      previous.entry.repeats++;
      previous.entry.time = time;
      return;
    }

    if (time - this.windowStart >= 1000) {
      if (this.windowDropped > 0) {
        const dropped = this.windowDropped;
        this.windowDropped = 0;
        this.windowStart = time;
        this.windowCount = 0;
        this.internal("warn", `${dropped} log entries were not stored (more than ${this.maxPerSecond} per second)`);
      } else {
        this.windowStart = time;
        this.windowCount = 0;
      }
    }
    if (this.windowCount >= this.maxPerSecond && input.level !== "error") {
      this.windowDropped++;
      this.droppedCount++;
      return;
    }
    this.windowCount++;

    const entry: LogEntry = { seq: ++this.seq, time, repeats: 1, pid: this.pid, ...input };
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    this.last = { key, entry };

    if (!input.persist) return;
    this.queue(entry);
    if (this.store && this.pending.length >= this.batchSize && !this.flushing && this.storeHealthy) setImmediate(() => void this.flush());
  }

  private queue(entry: LogEntry): void {
    if (this.pending.length >= this.maxPending) {
      this.droppedCount++;
      return;
    }
    this.pending.push(entry);
  }

  private print(level: LogLevel, args: readonly unknown[]): void {
    const mode = this.consoleMode;
    if (mode === "none") return;
    if (mode === "error" && level !== "error") return;
    try {
      const write = level === "error" ? this.output.error : level === "warn" ? this.output.warn : level === "debug" ? this.output.debug : this.output.log;
      write(...(args as unknown[]));
    } catch {
      // a closed stdout (EPIPE) must not break logging
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /**
   * Writes the pending entries (in batches). Resolves when everything pending was written or the store failed; never
   * rejects. Concurrent calls share the running flush.
   */
  flush(): Promise<void> {
    if (!this.store) return Promise.resolve();
    // A flush already running may have taken its batch before the newest entries arrived: write those afterwards.
    if (this.flushing) return this.flushing.then(() => (this.pending.length > 0 ? this.flush() : undefined));
    if (this.now() < this.retryAt) return Promise.resolve();

    const run = async (): Promise<void> => {
      const store = this.store;
      while (store && this.pending.length > 0) {
        const batch = this.pending.slice(0, this.batchSize);
        for (const entry of batch) this.sealed.add(entry);
        try {
          await store.insertMany(batch.map(toRecord));
          this.pending.splice(0, batch.length);
          this.persistedCount += batch.length;
          this.storeHealthy = true;
          this.failures = 0;
        } catch (error) {
          this.onStoreFailure(error);
          return;
        }
      }
    };
    this.flushing = run().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private onStoreFailure(error: unknown): void {
    this.storeHealthy = false;
    this.failures++;
    this.lastStoreError = (error as Error)?.message ?? String(error);
    this.retryAt = this.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures - 1, 5));
    const now = this.now();
    if (now - this.lastStoreErrorReportAt >= STORE_ERROR_REPORT_MS) {
      this.lastStoreErrorReportAt = now;
      this.internal("error", `Persisting logs failed (kept in memory, retrying): ${this.lastStoreError}`);
    }
  }

  // ── Reading ─────────────────────────────────────────────────────────

  /** Newest first. */
  recent(filter: LogFilter = {}): LogEntry[] {
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    const levels = filter.levels && filter.levels.length > 0 ? new Set(filter.levels) : null;
    const q = filter.q ? filter.q.toLowerCase() : null;
    const out: LogEntry[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.ring[i];
      if (filter.beforeSeq && entry.seq >= filter.beforeSeq) continue;
      if (levels && !levels.has(entry.level)) continue;
      if (filter.scope && entry.scope !== filter.scope) continue;
      if (filter.fromMs && entry.time < filter.fromMs) continue;
      if (filter.toMs && entry.time > filter.toMs) continue;
      if (q && !entry.message.toLowerCase().includes(q) && !(entry.details ?? "").toLowerCase().includes(q)) continue;
      out.push(entry);
    }
    return out;
  }

  /** Entry counts per level and scope of the ring buffer since `sinceMs` (used when the database is unavailable). */
  summarize(sinceMs: number): { levels: Record<LogLevel, number>; scopes: Array<{ scope: string; count: number }> } {
    const levels: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    const scopes = new Map<string, number>();
    for (const entry of this.ring) {
      if (entry.time < sinceMs) continue;
      levels[entry.level] += entry.repeats;
      scopes.set(entry.scope, (scopes.get(entry.scope) ?? 0) + entry.repeats);
    }
    return { levels, scopes: [...scopes].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count) };
  }

  stats(): LogSinkStats {
    return {
      buffered: this.ring.length,
      capacity: this.capacity,
      pending: this.pending.length,
      persisted: this.persistedCount,
      dropped: this.droppedCount,
      storeAttached: this.store !== null,
      storeHealthy: this.store !== null && this.storeHealthy,
      lastStoreError: this.lastStoreError,
      consoleMode: this.consoleMode,
      minLevel: this.minLevel,
    };
  }

  /** Test helper: forgets everything recorded so far. */
  clear(): void {
    this.ring.length = 0;
    this.pending = [];
    this.last = null;
  }
}

function toRecord(entry: LogEntry): LogRecord {
  return {
    time: entry.time,
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
    details: entry.details,
    userId: entry.userId,
    room: entry.room,
    repeats: entry.repeats,
    pid: entry.pid,
  };
}

/** The process-wide sink. Configured at boot by `bootstrap/logging.ts`; before that it prints like the plain console. */
export const logSink = new LogSink();
