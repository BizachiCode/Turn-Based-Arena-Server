import type { RequestResultStore, StoredRequestResult } from "../../src/shared/kernel/idempotency";

/**
 * In-memory `user_request_results`. It takes part in the in-memory unit of work (rolled back with the transaction) and
 * mimics InnoDB: `claim` of a request id that another transaction claimed but has not completed yet WAITS for it, then
 * reports the duplicate.
 */
export class InMemoryRequestResultStore implements RequestResultStore {
  rows = new Map<string, { kind: string; response: unknown | null }>();
  private waiters = new Map<string, Array<() => void>>();
  claims = 0;

  private key(userId: string, requestId: string): string {
    return `${userId}|${requestId}`;
  }

  async find(userId: string, requestId: string): Promise<StoredRequestResult | null> {
    const row = this.rows.get(this.key(userId, requestId));
    // Uncommitted claims (response still null) are invisible to other transactions.
    return row && row.response !== null ? { kind: row.kind, response: structuredClone(row.response) } : null;
  }

  async claim(userId: string, requestId: string, kind: string): Promise<boolean> {
    const key = this.key(userId, requestId);
    this.claims++;
    while (this.rows.has(key)) {
      const row = this.rows.get(key)!;
      if (row.response !== null) return false;
      await new Promise<void>((resolve) => { (this.waiters.get(key) ?? this.waiters.set(key, []).get(key)!).push(resolve); });
      // The first transaction finished: committed (row stays with its response) or rolled back (row removed).
    }
    this.rows.set(key, { kind, response: null });
    return true;
  }

  async complete(userId: string, requestId: string, response: unknown): Promise<void> {
    const key = this.key(userId, requestId);
    const row = this.rows.get(key);
    if (!row) throw new Error("complete without claim");
    row.response = structuredClone(response);
    this.release(key);
  }

  snapshot() {
    return new Map([...this.rows].map(([key, row]) => [key, { ...row }]));
  }

  restore(state: unknown) {
    const before = new Set(this.rows.keys());
    this.rows = state as Map<string, { kind: string; response: unknown | null }>;
    for (const key of before) if (!this.rows.has(key)) this.release(key);
  }

  private release(key: string): void {
    const waiting = this.waiters.get(key) ?? [];
    this.waiters.delete(key);
    for (const resolve of waiting) resolve();
  }
}
