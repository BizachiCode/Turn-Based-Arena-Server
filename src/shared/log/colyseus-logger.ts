// The logger handed to Colyseus (`defineServer({ logger })`): its internal messages ("# SERVER_ERROR: ...", room
// lifecycle errors, matchmaking failures) go through the log sink like everything else.
import { createLogger } from "../logger.js";

/** Colyseus' `Logger` shape (debug / info / warn / error / trace). */
export function createColyseusLogger() {
  const log = createLogger("Colyseus");
  const text = (args: unknown[]): [string, ...unknown[]] => {
    const [first, ...rest] = args;
    return [typeof first === "string" ? first : first instanceof Error ? first.message : String(first), ...(first instanceof Error ? [first, ...rest] : rest)];
  };
  return {
    debug: (...args: unknown[]) => log.debug(...text(args)),
    trace: (...args: unknown[]) => log.debug(...text(args)),
    info: (...args: unknown[]) => log.info(...text(args)),
    warn: (...args: unknown[]) => log.warn(...text(args)),
    error: (...args: unknown[]) => log.error(...text(args)),
  };
}
