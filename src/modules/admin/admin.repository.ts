import { eq, like, or, sql, asc } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userProfile, users } from "../../infrastructure/database/schema/index.js";
import type { AdminUserDirectory, AdminUserRef } from "./admin.ports.js";

const columns = { userId: users.id, username: users.username, email: users.email, name: userProfile.name };

/** Escapes LIKE wildcards in user input. */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** `audit_events.meta` comes back from the driver as JSON text: hands out the parsed value (the text when it is not JSON). */
export function parseJsonMeta(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class DrizzleAdminUserDirectory extends DrizzleRepository implements AdminUserDirectory {
  constructor(database: Database) {
    super(database);
  }

  // The in-game nickname (user_profile.name, unique) counts like the username: it is what the Players list shows first.
  async resolve(selector: string): Promise<AdminUserRef | null> {
    const [row] = await this.database.select(columns).from(users).leftJoin(userProfile, eq(userProfile.userId, users.id))
      .where(or(eq(users.id, selector), eq(users.username, selector), eq(users.email, selector), eq(userProfile.name, selector))).limit(1);
    return row ?? null;
  }

  async search(query: string, limit: number): Promise<AdminUserRef[]> {
    const pattern = likeContains(query);
    return this.database.select(columns).from(users).leftJoin(userProfile, eq(userProfile.userId, users.id))
      .where(or(like(users.id, pattern), like(users.username, pattern), like(users.email, pattern), like(userProfile.name, pattern)))
      .orderBy(
        sql`CASE WHEN ${users.id} = ${query} THEN 0 WHEN ${users.username} = ${query} THEN 1 WHEN ${userProfile.name} = ${query} THEN 2 WHEN ${users.email} = ${query} THEN 3 ELSE 4 END`,
        asc(users.username),
      )
      .limit(limit);
  }
}
