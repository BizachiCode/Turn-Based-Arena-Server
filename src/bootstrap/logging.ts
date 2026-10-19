// First import of the entry point (after the dev .env bootstrap): from here on nothing reaches the terminal unless
// LOG_CONSOLE says so. console.*, Colyseus' logger and the process error events are recorded by the log sink and read
// in the GM panel (Logs). The database persistence is attached later, once the connection is ready (app.config.ts).

import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { installConsoleCapture } from "../shared/log/console-capture.js";
import { logSink } from "../shared/log/log-sink.js";
import { parseLogConsoleMode, parseLogLevel } from "../shared/log/log-types.js";

const mode = parseLogConsoleMode(process.env.LOG_CONSOLE);
const capacity = Number.parseInt(process.env.LOG_BUFFER_SIZE ?? "", 10);

logSink.configure({ consoleMode: mode, minLevel: parseLogLevel(process.env.LOG_LEVEL), capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : undefined });
const capture = installConsoleCapture(logSink);

if (mode === "none") {
  const port = process.env.PORT || "2567";
  capture.originals.log(`[logs] Server logs are in the GM panel (http://localhost:${port}/gm, section Logs). Terminal output: LOG_CONSOLE=none (use error or all to print here).`);
}
