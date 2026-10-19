// src/index.ts — process entry point (`npm start` / `npm run start:prod`).
import "./bootstrap/first-run.js";
import "./bootstrap/logging.js";
import { listen } from "@colyseus/tools";
import { env } from "./config/env.js";
import server from "./app.config.js";
import { db, pool } from "./infrastructure/database/drizzle.js";
import { prepareDatabase } from "./infrastructure/database/migrate.js";
import { disconnectRedis } from "./infrastructure/database/redis.js";
import { reportFatal } from "./shared/log/console-capture.js";
import { logSink } from "./shared/log/log-sink.js";

// Colyseus handles SIGTERM/SIGINT (graceful shutdown); release our own resources afterwards.
server.onShutdown(async () => {
  await logSink.flush();
  await disconnectRedis();
  await pool.end().catch((): void => undefined);
});

async function main(): Promise<void> {
  if (env.dbAutoMigrate) {
    await prepareDatabase(db, env.mysql);
  }
  await listen(server);
}

main().catch(async (error: Error) => {
  reportFatal(logSink, `\n[startup] ${error.message}\n`);
  await logSink.flush();
  await pool.end().catch((): void => undefined);
  process.exit(1);
});
