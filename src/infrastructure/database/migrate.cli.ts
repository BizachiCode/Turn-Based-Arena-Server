// `npm run db:migrate` — creates the database if needed, applies pending migrations and exits.

import "../../bootstrap/first-run.js";
import { env } from "../../config/env.js";
import { db, pool } from "./drizzle.js";
import { prepareDatabase } from "./migrate.js";

prepareDatabase(db, env.mysql)
  .then(() => pool.end())
  .catch(async (error: Error) => {
    console.error(`\n${error.message}\n`);
    await pool.end().catch((): void => undefined);
    process.exit(1);
  });
