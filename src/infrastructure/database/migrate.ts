// Database preparation: create the database if missing, then apply pending drizzle migrations.
// Runs on every start (dev and production) before Colyseus listens, and via `npm run db:migrate`.

import path from "node:path";
import fs from "node:fs";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import type { Database } from "./drizzle.js";

export type MysqlConnectionSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

/** `./drizzle` at the project root (works from `src/` with tsx and from `build/` with node). */
export function resolveMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const fromModule = path.resolve(__dirname, "../../../drizzle");
  return fs.existsSync(fromModule) ? fromModule : path.resolve(process.cwd(), "drizzle");
}

/** Human readable explanation for the usual connection failures. */
export function describeConnectionError(error: unknown, settings: MysqlConnectionSettings): string {
  const code = (error as { code?: string })?.code ?? "";
  const target = `${settings.user}@${settings.host}:${settings.port}`;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "EHOSTUNREACH") {
    return [
      `Cannot reach MySQL/MariaDB at ${settings.host}:${settings.port} (${code}).`,
      "Start your database server (e.g. `sudo service mysql start`, XAMPP/MAMP control panel, or",
      "`docker run -d -p 3306:3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:8`) and check",
      "MYSQL_HOST / MYSQL_PORT in .env.",
    ].join("\n");
  }
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR") {
    return `MySQL rejected the credentials for ${target}. Set MYSQL_USER / MYSQL_PASSWORD in .env (the user needs CREATE privileges on the first run).`;
  }
  return `Database preparation failed for ${target}: ${(error as Error)?.message ?? String(error)}`;
}

/** Creates the configured database (utf8mb4) when it doesn't exist yet. */
export async function ensureDatabaseExists(settings: MysqlConnectionSettings): Promise<void> {
  const connection = await mysql.createConnection({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
  });
  try {
    await connection.query("CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", [settings.database]);
  } finally {
    await connection.end();
  }
}

async function appliedMigrationCount(db: Database): Promise<number> {
  try {
    const [rows] = (await db.execute(sql`SELECT COUNT(*) AS c FROM ${sql.identifier("__drizzle_migrations")}`)) as unknown as [Array<{ c: number }>];
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

/** Ensures the database exists and applies pending migrations. Returns how many were applied. */
export async function prepareDatabase(db: Database, settings: MysqlConnectionSettings, log: (message: string) => void = console.log): Promise<number> {
  try {
    await ensureDatabaseExists(settings);
    const before = await appliedMigrationCount(db);
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
    const applied = (await appliedMigrationCount(db)) - before;
    log(applied > 0 ? `[db] applied ${applied} migration(s); database "${settings.database}" is up to date` : `[db] database "${settings.database}" is up to date`);
    return applied;
  } catch (error) {
    throw new Error(describeConnectionError(error, settings), { cause: error });
  }
}
