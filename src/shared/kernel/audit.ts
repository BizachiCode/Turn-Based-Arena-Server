import type { DbSession } from "./unit-of-work.js";

/** Audit trail entry (economy grants, purchases, rewards, admin actions). */
export type AuditEntry = {
  userId: string | null;
  /** e.g. SHOP_PURCHASE, STAGE_REWARD, GM_GRANT_CURRENCY, ADMIN_MAINTENANCE. */
  kind: string;
  meta?: Record<string, unknown> | null;
};

/** Port: append-only audit log. Pass the session to commit the entry with the use case. */
export interface AuditLog {
  record(entry: AuditEntry, session?: DbSession): Promise<void>;
}

/** Audit log that drops entries (tests). */
export const noAudit: AuditLog = { record: async () => undefined };
