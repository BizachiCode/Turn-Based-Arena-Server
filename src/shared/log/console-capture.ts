// Routes everything that would reach the terminal into the log sink: console.*, Colyseus' logger, warnings and the
// process-level error events. Installed once at boot (`bootstrap/logging.ts`).

import type { ConsoleOutput, LogSink } from "./log-sink.js";
import type { LogLevel } from "./log-types.js";

type ConsoleMethod = keyof ConsoleOutput | "trace";

const METHOD_LEVEL: Record<ConsoleMethod, LogLevel> = {
  log: "info",
  info: "info",
  debug: "debug",
  trace: "debug",
  warn: "warn",
  error: "error",
};

export type ConsoleCapture = {
  /** Puts the console and the process listeners back (tests). */
  uninstall(): void;
  /** The functions that really print to the terminal. */
  originals: ConsoleOutput;
};

let active: ConsoleCapture | null = null;

/**
 * Replaces `console.log/info/debug/trace/warn/error` with functions that record into `sink`. What reaches the terminal is
 * decided by the sink (`LOG_CONSOLE`), using the original functions returned in `originals`. Calling it twice returns
 * the first installation.
 */
export function installConsoleCapture(sink: LogSink, target: Console = console): ConsoleCapture {
  if (active) return active;

  const originals: ConsoleOutput = {
    log: target.log.bind(target),
    info: target.info.bind(target),
    warn: target.warn.bind(target),
    error: target.error.bind(target),
    debug: target.debug.bind(target),
  };
  sink.useOutput(originals);

  const previous: Partial<Record<ConsoleMethod, unknown>> = {};
  for (const method of Object.keys(METHOD_LEVEL) as ConsoleMethod[]) {
    previous[method] = (target as unknown as Record<string, unknown>)[method];
    (target as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      sink.record(METHOD_LEVEL[method], null, args);
    };
  }

  const onWarning = (warning: Error): void => {
    sink.record("warn", "Node", [`${warning.name}: ${warning.message}`]);
  };
  const onRejection = (reason: unknown): void => {
    sink.record("error", "Process", ["Unhandled promise rejection:", reason instanceof Error ? reason : new Error(String(reason))]);
  };
  const onException = (error: Error, origin?: string): void => {
    const fatal = process.listenerCount("uncaughtException") <= 1;
    sink.record("error", "Process", [`Uncaught exception${origin ? ` (${origin})` : ""}:`, error]);
    // Colyseus registers its own handler (graceful shutdown). When this is the only one, behave like Node does without
    // any handler: tell the terminal and exit, after giving the sink a moment to write the entry.
    if (fatal) {
      originals.error(`\n[fatal] uncaught exception: ${error?.stack ?? error}\n`);
      void Promise.race([sink.flush(), new Promise((resolve) => setTimeout(resolve, 1500))]).finally(() => process.exit(1));
    }
  };
  // Printed whatever LOG_CONSOLE says: a process that dies must leave a trace in the terminal.
  const onExit = (code: number): void => {
    if (code !== 0 && sink.getConsoleMode() === "none") originals.error(`[fatal] the server stopped with exit code ${code}; see the GM panel Logs for details`);
  };

  process.on("warning", onWarning);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  process.on("exit", onExit);

  active = {
    originals,
    uninstall() {
      for (const method of Object.keys(METHOD_LEVEL) as ConsoleMethod[]) {
        (target as unknown as Record<string, unknown>)[method] = previous[method];
      }
      process.off("warning", onWarning);
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
      process.off("exit", onExit);
      sink.useOutput(originals);
      active = null;
    },
  };
  return active;
}

/** The fatal-error path: always reaches the terminal (and the sink), whatever LOG_CONSOLE says. */
export function reportFatal(sink: LogSink, message: string, error?: unknown): void {
  sink.record("error", "Fatal", error === undefined ? [message] : [message, error]);
  const out = active?.originals.error ?? console.error.bind(console);
  out(error instanceof Error ? `${message}\n${error.stack ?? error.message}` : message);
}
