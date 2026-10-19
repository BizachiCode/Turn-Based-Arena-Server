// Idempotent mutations: a client `requestId` makes a request safe to retry (timeout, dropped socket). The response of
// the first successful call is stored per (user, request id) in the SAME transaction as the mutation; a repeated id
// returns that response without running the mutation again.
//
//   const hit = await idempotency.replay<MyDto>(userId, requestId, "kind");   // before any validation / roll
//   if (hit) return hit;
//   const { value, replayed } = await idempotency.run(userId, requestId, "kind", async (session) => { ...; return dto; });
//   if (!replayed) { /* post-commit side effects: cache invalidation, activity */ }
//   return value;
//
// The transaction callback may be re-run by the unit of work after a deadlock: it must not keep state from a previous
// attempt (the claim row is rolled back with the attempt, so claiming again is safe).

import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";
import type { DbSession, UnitOfWork } from "./unit-of-work.js";

/** 1..64 characters of [A-Za-z0-9_-]. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Optional `requestId` field of the idempotent request payloads (zod). */
export const RequestIdSchema = z.string().regex(REQUEST_ID_PATTERN).optional();

export type StoredRequestResult = { kind: string; response: unknown };

/** Persistence of the stored responses (`user_request_results`). */
export interface RequestResultStore {
  /** The stored result, or null (never stored, or purged). */
  find(userId: string, requestId: string, session?: DbSession): Promise<StoredRequestResult | null>;
  /** Reserves (user, request id) inside the transaction; false when it already exists. May wait for a running first call. */
  claim(userId: string, requestId: string, kind: string, session: DbSession): Promise<boolean>;
  /** Stores the response of the claimed request (same transaction). */
  complete(userId: string, requestId: string, response: unknown, session: DbSession): Promise<void>;
}

/** Thrown inside the transaction when the request id already exists, to roll the claim back and re-read the result. */
class AlreadyClaimed extends Error {
  constructor() {
    super("request already claimed");
  }
}

export class Idempotency {
  /** `store` null disables the feature (the request id is ignored). */
  constructor(
    private readonly store: RequestResultStore | null,
    private readonly uow: UnitOfWork,
  ) {}

  /** The response stored for a repeated request (marked `replayed: true`), or null when this id is new. */
  async replay<T extends object>(userId: string, requestId: string | undefined | null, kind: string): Promise<T | null> {
    if (!requestId || !this.store) return null;
    const stored = await this.store.find(userId, requestId);
    return stored ? this.asReplay<T>(stored, kind) : null;
  }

  /**
   * Runs `work` in a transaction. With a request id the claim row is inserted first (a concurrent call with the same id
   * waits for this transaction, then reads its result) and the response is stored before the commit.
   */
  async run<T extends object>(
    userId: string,
    requestId: string | undefined | null,
    kind: string,
    work: (session: DbSession) => Promise<T>,
  ): Promise<{ value: T; replayed: boolean }> {
    const store = this.store;
    if (!requestId || !store) return { value: await this.uow.transaction(work), replayed: false };

    try {
      const value = await this.uow.transaction(async (session) => {
        if (!(await store.claim(userId, requestId, kind, session))) throw new AlreadyClaimed();
        const result = await work(session);
        await store.complete(userId, requestId, result, session);
        return result;
      });
      return { value, replayed: false };
    } catch (error) {
      if (!(error instanceof AlreadyClaimed)) throw error;
      const stored = await store.find(userId, requestId);
      // Committed rows always hold their response; a missing one means the first call vanished (purge): treat as conflict.
      if (!stored) throw new AppError(ErrorCode.REQUEST_ID_CONFLICT);
      return { value: this.asReplay<T>(stored, kind), replayed: true };
    }
  }

  private asReplay<T extends object>(stored: StoredRequestResult, kind: string): T {
    if (stored.kind !== kind || stored.response === null || typeof stored.response !== "object") {
      throw new AppError(ErrorCode.REQUEST_ID_CONFLICT);
    }
    return { ...(stored.response as T), replayed: true };
  }
}
