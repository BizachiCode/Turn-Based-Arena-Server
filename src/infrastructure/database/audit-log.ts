import type { AuditEntry, AuditLog } from "../../shared/kernel/audit.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "./drizzle.js";
import { DrizzleRepository } from "./drizzle-unit-of-work.js";
import { auditEvents } from "./schema/index.js";

/** Drizzle implementation of {@link AuditLog} (`audit_events`). */
export class DrizzleAuditLog extends DrizzleRepository implements AuditLog {
  constructor(database: Database) {
    super(database);
  }

  async record(entry: AuditEntry, session?: DbSession): Promise<void> {
    await this.db(session).insert(auditEvents).values({
      userId: entry.userId,
      kind: entry.kind.slice(0, 32),
      meta: entry.meta ?? null,
    });
  }
}
