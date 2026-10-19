// GM panel "Logs": filtered, paged log entries and the counters of the last 24 hours. Reads the `server_logs` table
// (after asking the sink to write what it still holds); when the database cannot answer it falls back to the ring
// buffer of the sink so the panel keeps showing what just happened (including why the database failed).

import type { Clock } from "../../shared/kernel/clock.js";
import type { LogFilter, LogSinkStats } from "../../shared/log/log-sink.js";
import type { LogEntry } from "../../shared/log/log-types.js";
import type { AdminLogLevelCounts, AdminLogQuery, AdminLogRow, AdminLogsRepository } from "./admin-logs.ports.js";

/** The part of the log sink the panel needs (the real `LogSink` satisfies it). */
export interface AdminLogSink {
  flush(): Promise<void>;
  recent(filter?: LogFilter): LogEntry[];
  summarize(sinceMs: number): { levels: AdminLogLevelCounts; scopes: Array<{ scope: string; count: number }> };
  stats(): LogSinkStats;
}

export type AdminLogsDeps = {
  repo: AdminLogsRepository;
  sink: AdminLogSink;
  clock: Clock;
  /** Retention shown in the panel (days). */
  retentionDays: number;
};

export type AdminLogsPage = {
  entries: AdminLogRow[];
  /** Where the entries came from: the database, or the memory ring buffer when the database is unavailable. */
  source: "database" | "memory";
  /** Pass as `before` to load the next (older) page; null when there is none. */
  nextBefore: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FLUSH_WAIT_MS = 1500;
const SCOPE_LIMIT = 100;

export class AdminLogsService {
  constructor(private readonly deps: AdminLogsDeps) {}

  async list(query: Partial<AdminLogQuery>): Promise<AdminLogsPage> {
    const full: AdminLogQuery = {
      levels: query.levels ?? [],
      scope: query.scope || null,
      q: query.q?.trim() || null,
      from: query.from ?? null,
      to: query.to ?? null,
      before: query.before ?? null,
      limit: query.limit ?? 100,
    };
    const { sink, repo } = this.deps;

    if (sink.stats().storeAttached) {
      await withTimeout(sink.flush(), FLUSH_WAIT_MS);
      try {
        const entries = await repo.query(full);
        return { entries, source: "database", nextBefore: entries.length >= full.limit ? entries[entries.length - 1].id : null };
      } catch {
        // fall through to the memory buffer
      }
    }

    const entries = sink.recent({
      levels: full.levels,
      scope: full.scope,
      q: full.q,
      fromMs: full.from?.getTime() ?? null,
      toMs: full.to?.getTime() ?? null,
      beforeSeq: full.before,
      limit: full.limit,
    }).map(toRow);
    return { entries, source: "memory", nextBefore: entries.length >= full.limit ? entries[entries.length - 1].id : null };
  }

  /** Counters of the last 24 hours, the scopes seen and the state of the sink. */
  async summary() {
    const { sink, repo, clock, retentionDays } = this.deps;
    const since = new Date(clock.nowMs() - DAY_MS);
    let counts: AdminLogLevelCounts;
    let scopes: Array<{ scope: string; count: number }>;
    let source: "database" | "memory" = "database";

    const attached = sink.stats().storeAttached;
    if (attached) await withTimeout(sink.flush(), FLUSH_WAIT_MS);
    try {
      if (!attached) throw new Error("log store not attached");
      [counts, scopes] = await Promise.all([repo.levelCounts(since), repo.scopes(since, SCOPE_LIMIT)]);
    } catch {
      const memory = sink.summarize(since.getTime());
      counts = memory.levels;
      scopes = memory.scopes.slice(0, SCOPE_LIMIT);
      source = "memory";
    }

    return { since: since.toISOString(), counts, scopes, source, retentionDays, sink: sink.stats() };
  }
}

function toRow(entry: LogEntry): AdminLogRow {
  return {
    id: entry.seq,
    time: new Date(entry.time).toISOString(),
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

async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work.catch((): void => undefined), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
