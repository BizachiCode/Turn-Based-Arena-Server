import assert from "node:assert/strict";

import { installConsoleCapture } from "../src/shared/log/console-capture";
import { formatLogArgs, redactSecrets, splitScope } from "../src/shared/log/log-format";
import { LogSink, type ConsoleOutput } from "../src/shared/log/log-sink";
import { parseLogConsoleMode, parseLogLevel, type LogRecord, type LogStore } from "../src/shared/log/log-types";
import { createLogger } from "../src/shared/logger";
import { logSink } from "../src/shared/log/log-sink";

/** Fake clock the sink reads (ms). */
function clockAt(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function fakeOutput() {
  const lines: Array<[string, unknown[]]> = [];
  const output = Object.fromEntries((["log", "info", "warn", "error", "debug"] as const).map((method) => [method, (...args: unknown[]) => { lines.push([method, args]); }])) as ConsoleOutput;
  return { lines, output };
}

class FakeStore implements LogStore {
  batches: LogRecord[][] = [];
  failures = 0;
  calls = 0;
  async insertMany(records: readonly LogRecord[]): Promise<void> {
    this.calls++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("database is down");
    }
    this.batches.push([...records]);
  }
  get rows(): LogRecord[] { return this.batches.flat(); }
}

function sinkWith(options: ConstructorParameters<typeof LogSink>[0] = {}) {
  const clock = clockAt();
  const { lines, output } = fakeOutput();
  const sink = new LogSink({ consoleMode: "none", now: clock.now, output, flushIntervalMs: 60_000, ...options });
  return { sink, clock, lines };
}

describe("Log formatting", () => {
  it("splits the [Tag] prefix from the message", () => {
    assert.deepEqual(splitScope("[ShopCatalog] loaded 4 items"), { scope: "ShopCatalog", rest: "loaded 4 items" });
    assert.deepEqual(splitScope("no tag here"), { scope: null, rest: "no tag here" });
    assert.deepEqual(splitScope("[unterminated"), { scope: null, rest: "[unterminated" });
  });

  it("keeps the first line as the message and the rest, with error stacks, as details", () => {
    const error = new Error("boom");
    const { message, details } = formatLogArgs(["save failed:", error]);
    assert.equal(message, "save failed: boom");
    assert.ok(details?.includes("Error: boom"));
    assert.ok(details?.includes("log_sink_test"), "the stack is kept");

    const multi = formatLogArgs(["first line\nsecond line\nthird"]);
    assert.equal(multi.message, "first line");
    assert.equal(multi.details, "second line\nthird");

    assert.equal(formatLogArgs([new Error("only")]).message, "only");
    assert.equal(formatLogArgs(["a", 3, { b: 1 }]).message, "a 3 { b: 1 }");
  });

  it("includes the driver error code and the cause chain", () => {
    const cause = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
    const { details } = formatLogArgs([new Error("query failed", { cause })]);
    assert.ok(details?.includes("Caused by"));
    assert.ok(details?.includes("ER_DUP_ENTRY"));
  });

  it("truncates huge messages and never throws on odd arguments", () => {
    const { message, details } = formatLogArgs(["x".repeat(5000)]);
    assert.ok(message.length <= 2000);
    assert.ok(details && details.length > 2000);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => formatLogArgs([circular, Symbol("s"), undefined, null, 10n]));
  });

  it("redacts tokens and secret-looking fields", () => {
    assert.equal(redactSecrets("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM ok").includes("eyJ"), false);
    assert.equal(redactSecrets('{"password":"hunter2","name":"bob"}'), '{"password":"[redacted]","name":"bob"}');
    assert.equal(redactSecrets("Authorization: abc123def"), "Authorization: [redacted]");
    assert.equal(redactSecrets("nothing to hide"), "nothing to hide");
    const { message } = formatLogArgs(["login with token=abcdef123456"]);
    assert.equal(message, "login with token=[redacted]");
  });

  it("parses the LOG_CONSOLE / LOG_LEVEL settings", () => {
    assert.equal(parseLogConsoleMode(undefined), "none");
    assert.equal(parseLogConsoleMode("ALL"), "all");
    assert.equal(parseLogConsoleMode("error"), "error");
    assert.equal(parseLogConsoleMode("verbose"), "none");
    assert.equal(parseLogLevel("warn"), "warn");
    assert.equal(parseLogLevel("nonsense"), "info");
  });
});

describe("LogSink buffer", () => {
  it("keeps the newest entries in a bounded ring and filters them", () => {
    const { sink } = sinkWith({ capacity: 10 });
    for (let i = 1; i <= 25; i++) sink.record(i % 5 === 0 ? "error" : "info", i % 2 ? "Odd" : "Even", [`entry ${i}`]);
    const stats = sink.stats();
    assert.equal(stats.buffered, 10);

    const all = sink.recent({ limit: 100 });
    assert.deepEqual(all.map((entry) => entry.message), Array.from({ length: 10 }, (_v, i) => `entry ${25 - i}`), "newest first");
    assert.deepEqual(sink.recent({ levels: ["error"] }).map((entry) => entry.message), ["entry 25", "entry 20"], "only the 10 newest entries are kept");
    assert.deepEqual(sink.recent({ scope: "Even" }).map((entry) => entry.message), ["entry 24", "entry 22", "entry 20", "entry 18", "entry 16"]);
    assert.deepEqual(sink.recent({ q: "ENTRY 2" }).map((entry) => entry.message), ["entry 25", "entry 24", "entry 23", "entry 22", "entry 21", "entry 20"]);
    const page = sink.recent({ limit: 3 });
    assert.deepEqual(sink.recent({ limit: 3, beforeSeq: page[2].seq }).map((entry) => entry.message), ["entry 22", "entry 21", "entry 20"]);
  });

  it("uses the [Tag] of a raw message as the scope and `console` otherwise", () => {
    const { sink } = sinkWith();
    sink.record("info", null, ["[MapCatalog] loaded 3 regions"]);
    sink.record("warn", null, ["plain message"]);
    sink.record("info", "Explicit", ["[Ignored] stays in the text"]);
    const [explicit, plain, tagged] = sink.recent();
    assert.deepEqual([tagged.scope, tagged.message], ["MapCatalog", "loaded 3 regions"]);
    assert.deepEqual([plain.scope, plain.level], ["console", "warn"]);
    assert.deepEqual([explicit.scope, explicit.message], ["Explicit", "[Ignored] stays in the text"]);
  });

  it("drops entries below the minimum level and carries the user / room context", () => {
    const { sink } = sinkWith({ minLevel: "warn" });
    sink.record("info", "A", ["quiet"]);
    sink.record("warn", "A", ["loud"], { userId: "u-1", room: "summon" });
    const entries = sink.recent();
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0].userId, entries[0].room], ["u-1", "summon"]);
  });

  it("folds identical consecutive entries while the first is waiting to be stored", async () => {
    const { sink, clock } = sinkWith();
    const store = new FakeStore();
    for (let i = 0; i < 5; i++) { sink.record("error", "Db", ["connection lost"]); clock.advance(100); }
    sink.record("error", "Db", ["another problem"]);
    sink.record("error", "Db", ["connection lost"]);
    const entries = sink.recent();
    assert.equal(entries.length, 3);
    assert.equal(entries[2].repeats, 5);

    sink.attachStore(store);
    await sink.flush();
    assert.deepEqual(store.rows.map((row) => [row.message, row.repeats]), [["connection lost", 5], ["another problem", 1], ["connection lost", 1]]);

    // Once stored, a repeat is a new row.
    sink.record("error", "Db", ["connection lost"]);
    sink.record("error", "Db", ["connection lost"]);
    await sink.flush();
    assert.equal(store.rows.length, 4);
    assert.equal(store.rows[3].repeats, 2);
  });

  it("does not fold repeats that are far apart", () => {
    const { sink, clock } = sinkWith({ dedupeWindowMs: 1000 });
    sink.record("info", "A", ["tick"]);
    clock.advance(5000);
    sink.record("info", "A", ["tick"]);
    assert.equal(sink.recent().length, 2);
  });

  it("caps a flood per second but always keeps errors, and reports what it dropped once", () => {
    const { sink, clock } = sinkWith({ maxPerSecond: 20 });
    for (let i = 0; i < 100; i++) sink.record("info", "Spam", [`line ${i}`]);
    sink.record("error", "Spam", ["still recorded"]);
    assert.equal(sink.recent({ scope: "Spam", levels: ["info"], limit: 500 }).length, 20);
    assert.equal(sink.recent({ levels: ["error"] }).length, 1);
    assert.equal(sink.stats().dropped, 80);

    clock.advance(1500);
    sink.record("info", "Spam", ["next second"]);
    const summary = sink.recent({ scope: "LogSink" });
    assert.equal(summary.length, 1);
    assert.match(summary[0].message, /80 log entries were not stored/);
  });

  it("summarises the buffer for the panel fallback", () => {
    const { sink, clock } = sinkWith();
    sink.record("info", "A", ["old"]);
    clock.advance(10_000);
    sink.record("warn", "A", ["new"]);
    sink.record("error", "B", ["bad"]);
    const summary = sink.summarize(clock.now() - 5000);
    assert.deepEqual(summary.levels, { debug: 0, info: 0, warn: 1, error: 1 });
    assert.deepEqual(summary.scopes.map((scope) => scope.scope).sort(), ["A", "B"]);
  });
});

describe("LogSink persistence", () => {
  it("writes pending entries in batches, in order, once a store is attached", async () => {
    const { sink } = sinkWith({ batchSize: 3 });
    const store = new FakeStore();
    for (let i = 1; i <= 7; i++) sink.record("info", "A", [`m${i}`]);
    assert.equal(sink.stats().pending, 7, "entries logged before the store exists wait for it");

    sink.attachStore(store);
    await sink.flush();
    assert.deepEqual(store.batches.map((batch) => batch.map((row) => row.message)), [["m1", "m2", "m3"], ["m4", "m5", "m6"], ["m7"]]);
    assert.equal(sink.stats().pending, 0);
    assert.equal(sink.stats().persisted, 7);
    assert.equal(store.rows[0].scope, "A");
    sink.stop();
  });

  it("flushes by itself when a full batch is waiting", async () => {
    const { sink } = sinkWith({ batchSize: 2 });
    const store = new FakeStore();
    sink.attachStore(store);
    sink.record("info", "A", ["one"]);
    sink.record("info", "A", ["two"]);
    await new Promise((resolve) => setImmediate(resolve));
    await sink.flush();
    assert.equal(store.rows.length, 2);
    sink.stop();
  });

  it("memory-only entries (about the sink itself) are never written", async () => {
    const { sink, clock } = sinkWith();
    const store = new FakeStore();
    store.failures = 1;
    sink.attachStore(store);
    sink.record("info", "A", ["real"]);
    await sink.flush();
    const internal = sink.recent({ scope: "LogSink" });
    assert.equal(internal.length, 1);
    assert.equal(internal[0].persist, false);

    clock.advance(5000);
    await sink.flush();
    assert.deepEqual(store.rows.map((row) => row.message), ["real"]);
    sink.stop();
  });

  it("recursion guard: a failing store never throws into the caller, backs off and reports once", async () => {
    const { sink, clock } = sinkWith();
    const store = new FakeStore();
    store.failures = 1000;
    sink.attachStore(store);

    assert.doesNotThrow(() => { for (let i = 0; i < 50; i++) sink.record("error", "Room", [`failure ${i}`]); });
    await sink.flush();
    const callsAfterFirst = store.calls;
    for (let i = 0; i < 20; i++) await sink.flush();
    assert.equal(store.calls, callsAfterFirst, "no hammering while backing off");
    assert.equal(sink.stats().storeHealthy, false);
    assert.match(sink.stats().lastStoreError ?? "", /database is down/);

    const reports = () => sink.recent({ scope: "LogSink", limit: 100 });
    assert.equal(reports().length, 1);

    // Backoff elapses: it tries again, still fails, and does not add a report within the minute.
    clock.advance(40_000);
    await sink.flush();
    assert.ok(store.calls > callsAfterFirst);
    assert.equal(reports().length, 1, "no new report within a minute");
    clock.advance(40_000);
    await sink.flush();
    assert.equal(reports().length, 2, "reported again after a minute");

    // The database comes back: the entries kept in memory are written.
    store.failures = 0;
    clock.advance(40_000);
    await sink.flush();
    assert.equal(store.rows.length, 50);
    assert.equal(sink.stats().storeHealthy, true);
    sink.stop();
  });

  it("recursion guard: logging from inside the sink output or a write path does not loop", () => {
    const calls: unknown[][] = [];
    const sink = new LogSink({ consoleMode: "all", flushIntervalMs: 60_000, output: Object.fromEntries((["log", "info", "warn", "error", "debug"] as const).map((method) => [method, (...args: unknown[]) => {
      calls.push(args);
      // A patched console printing back into the sink (what an unprotected interception would do).
      sink.record("info", "Loop", ["printed"]);
    }])) as unknown as ConsoleOutput });
    sink.record("info", "A", ["hello"]);
    assert.equal(calls.length, 1);
    assert.equal(sink.recent().length, 1);
  });

  it("bounds the queue while the store is down: the rest stays in memory", async () => {
    const { sink } = sinkWith({ maxPending: 100, batchSize: 10, capacity: 500, maxPerSecond: 10_000 });
    const store = new FakeStore();
    store.failures = 1000;
    sink.attachStore(store);
    for (let i = 0; i < 300; i++) sink.record("warn", "A", [`m${i}`]);
    assert.equal(sink.stats().pending, 100);
    assert.equal(sink.recent({ limit: 500 }).length, 300);
    assert.equal(sink.stats().dropped, 200);
    sink.stop();
  });
});

describe("Console output (LOG_CONSOLE)", () => {
  it("none prints nothing, error prints errors only, all prints everything", () => {
    for (const [mode, expected] of [["none", 0], ["error", 1], ["all", 3]] as const) {
      const { sink, lines } = sinkWith({ consoleMode: mode });
      sink.record("info", "A", ["info line"]);
      sink.record("warn", "A", ["warn line"]);
      sink.record("error", "A", ["error line"]);
      assert.equal(lines.length, expected, mode);
      assert.equal(sink.recent().length, 3, "the panel always gets every entry");
    }
  });

  it("prints the original arguments with the matching console method", () => {
    const { sink, lines } = sinkWith({ consoleMode: "all" });
    sink.record("error", "Tag", ["failed", { a: 1 }], undefined, ["[Tag]", "failed", { a: 1 }]);
    sink.record("warn", "Tag", ["careful"]);
    assert.deepEqual(lines, [["error", ["[Tag]", "failed", { a: 1 }]], ["warn", ["careful"]]]);
  });

  it("levels below LOG_LEVEL are neither stored nor printed", () => {
    const { sink, lines } = sinkWith({ consoleMode: "all", minLevel: "warn" });
    sink.record("debug", "A", ["noise"]);
    sink.record("info", "A", ["noise"]);
    assert.equal(lines.length, 0);
    assert.equal(sink.recent().length, 0);
  });

  it("a closed terminal (print throws) never breaks logging", () => {
    const sink = new LogSink({ consoleMode: "all", flushIntervalMs: 60_000, output: Object.fromEntries((["log", "info", "warn", "error", "debug"] as const).map((method) => [method, () => { throw new Error("EPIPE"); }])) as unknown as ConsoleOutput });
    assert.doesNotThrow(() => sink.record("error", "A", ["still stored"]));
    assert.equal(sink.recent().length, 1);
  });
});

describe("Console interception", () => {
  function fakeConsole() {
    const printed: string[] = [];
    const target: Record<string, unknown> = {};
    for (const method of ["log", "info", "warn", "error", "debug", "trace"]) target[method] = (...args: unknown[]) => { printed.push(`${method}:${args.join(" ")}`); };
    return { printed, target: target as unknown as Console };
  }

  it("routes console.* into the sink and keeps the terminal quiet unless the mode says otherwise", () => {
    const { printed, target } = fakeConsole();
    const { sink } = sinkWith({ minLevel: "debug" });
    const capture = installConsoleCapture(sink, target);
    try {
      target.log("[ArenaConfig] loaded 3 rivals");
      target.warn("careful", 42);
      target.error(new Error("kaboom"));
      target.debug("[Dbg] detail");
      target.info("[Info] fyi");
      target.trace("tracing");

      assert.deepEqual(printed, [], "LOG_CONSOLE=none: nothing reaches the terminal");
      const entries = sink.recent({ limit: 10 }).reverse();
      assert.deepEqual(entries.map((entry) => [entry.level, entry.scope, entry.message]), [
        ["info", "ArenaConfig", "loaded 3 rivals"],
        ["warn", "console", "careful 42"],
        ["error", "console", "kaboom"],
        ["debug", "Dbg", "detail"],
        ["info", "Info", "fyi"],
        ["debug", "console", "tracing"],
      ]);
      assert.ok(entries[2].details?.includes("Error: kaboom"));

      sink.configure({ consoleMode: "error" });
      target.log("hidden");
      target.error("shown");
      assert.deepEqual(capture.originals.error === undefined, false);
    } finally {
      capture.uninstall();
    }
  });

  it("prints through the ORIGINAL functions when the mode asks for it (no feedback loop)", () => {
    const { printed, target } = fakeConsole();
    const { sink } = sinkWith({ consoleMode: "all" });
    const capture = installConsoleCapture(sink, target);
    try {
      target.log("[Boot] hello");
      target.error("bad");
      assert.deepEqual(printed, ["log:[Boot] hello", "error:bad"]);
      assert.equal(sink.recent().length, 2, "recorded exactly once each");
    } finally {
      capture.uninstall();
    }
  });

  it("restores the console and the process listeners on uninstall", () => {
    const { target } = fakeConsole();
    const original = target.log;
    const before = process.listenerCount("unhandledRejection");
    const { sink } = sinkWith();
    const capture = installConsoleCapture(sink, target);
    assert.notEqual(target.log, original);
    assert.equal(process.listenerCount("unhandledRejection"), before + 1);
    capture.uninstall();
    assert.equal(target.log, original);
    assert.equal(process.listenerCount("unhandledRejection"), before);
  });

  it("records unhandled rejections, uncaught exceptions and warnings", () => {
    const { target } = fakeConsole();
    const { sink } = sinkWith();
    const rejection = new Set(process.listeners("unhandledRejection"));
    const exception = new Set(process.listeners("uncaughtException"));
    const warning = new Set(process.listeners("warning"));
    const capture = installConsoleCapture(sink, target);
    try {
      // The listeners are called directly: emitting the real events would also reach the test runner.
      const ours = <T extends (...args: never[]) => void>(event: "unhandledRejection" | "uncaughtException" | "warning", known: Set<unknown>) =>
        process.listeners(event).find((listener) => !known.has(listener)) as unknown as T;
      ours<(reason: unknown) => void>("unhandledRejection", rejection)(new Error("lost promise"));
      ours<(reason: unknown) => void>("unhandledRejection", rejection)("a string reason");
      ours<(error: Error, origin: string) => void>("uncaughtException", exception)(new Error("crash"), "uncaughtException");
      ours<(warning: Error) => void>("warning", warning)(Object.assign(new Error("old api"), { name: "DeprecationWarning" }));

      const entries = sink.recent({ limit: 10 }).reverse();
      assert.deepEqual(entries.map((entry) => [entry.level, entry.scope]), [["error", "Process"], ["error", "Process"], ["error", "Process"], ["warn", "Node"]]);
      assert.match(entries[0].message, /Unhandled promise rejection: lost promise/);
      assert.ok(entries[0].details?.includes("Error: lost promise"));
      assert.match(entries[1].message, /a string reason/);
      assert.match(entries[2].message, /Uncaught exception \(uncaughtException\): crash/);
      assert.match(entries[3].message, /DeprecationWarning: old api/);
    } finally {
      capture.uninstall();
    }
  });
});

describe("CreateLogger", () => {
  it("records into the process sink with its scope, level, details and context", () => {
    const before = logSink.stats();
    const logger = createLogger("UnitTestScope").with({ userId: "u-9", room: "summon" });
    logger.error("first problem:", new Error("inner"));
    logger.warn("second", { detail: 1 });
    const [warn, error] = logSink.recent({ scope: "UnitTestScope", limit: 2 });
    assert.equal(error.level, "error");
    assert.equal(error.message, "first problem: inner");
    assert.ok(error.details?.includes("Error: inner"));
    assert.deepEqual([error.userId, error.room], ["u-9", "summon"]);
    assert.deepEqual([warn.level, warn.message], ["warn", "second { detail: 1 }"]);
    assert.ok(logSink.stats().buffered >= before.buffered);
  });
});
