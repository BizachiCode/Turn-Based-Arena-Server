/**
 * Scoped logger. Every call goes to the log sink (`shared/log`): the GM panel "Logs" view, the `server_logs` table and,
 * depending on `LOG_CONSOLE`, the terminal. The lowest level that is recorded comes from `LOG_LEVEL`.
 */
import { logSink } from "./log/log-sink.js";
import type { LogContext, LogLevel } from "./log/log-types.js";

export type { LogLevel } from "./log/log-types.js";

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
  /** A logger whose entries carry the player / room they are about. */
  with(context: LogContext): Logger;
}

export function createLogger(scope: string, context?: LogContext): Logger {
  const prefix = `[${scope}]`;
  const write = (level: LogLevel, message: string, details: unknown[]) => {
    logSink.record(level, scope, [message, ...details], context, [prefix, message, ...details]);
  };

  return {
    debug: (message, ...details) => write("debug", message, details),
    info: (message, ...details) => write("info", message, details),
    warn: (message, ...details) => write("warn", message, details),
    error: (message, ...details) => write("error", message, details),
    with: (extra) => createLogger(scope, { ...context, ...extra }),
  };
}
