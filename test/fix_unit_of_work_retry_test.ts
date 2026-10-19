import assert from "node:assert/strict";

import { DrizzleUnitOfWork, isDeadlockError } from "../src/infrastructure/database/drizzle-unit-of-work";
import type { Database } from "../src/infrastructure/database/drizzle";

/** Database whose `transaction` runs the callback with a tx that accepts any `execute`. */
function fakeDatabase() {
  const stats = { transactions: 0 };
  const database = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      stats.transactions++;
      return callback({ execute: async () => undefined });
    },
  } as unknown as Database;
  return { database, stats };
}

const deadlock = () => Object.assign(new Error("Deadlock found when trying to get lock; try restarting transaction"), { errno: 1213, code: "ER_LOCK_DEADLOCK" });

describe("DrizzleUnitOfWork deadlock retry", () => {
  const options = { sleep: async () => undefined, random: () => 0 };

  it("recognises deadlocks, also when wrapped in a driver error cause", () => {
    assert.equal(isDeadlockError(deadlock()), true);
    assert.equal(isDeadlockError(Object.assign(new Error("Failed query"), { cause: deadlock() })), true);
    assert.equal(isDeadlockError(Object.assign(new Error("lock wait timeout"), { errno: 1205, code: "ER_LOCK_WAIT_TIMEOUT" })), false);
    assert.equal(isDeadlockError(new Error("boom")), false);
    assert.equal(isDeadlockError(null), false);
  });

  it("re-runs the whole callback after one deadlock and returns its result", async () => {
    const { database, stats } = fakeDatabase();
    const uow = new DrizzleUnitOfWork(database, 5, options);
    let calls = 0;
    const result = await uow.transaction(async () => {
      calls++;
      if (calls === 1) throw deadlock();
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(calls, 2);
    assert.equal(stats.transactions, 2, "each attempt is a new transaction");
  });

  it("gives up after the bounded number of retries and rethrows the deadlock", async () => {
    const { database } = fakeDatabase();
    const waits: number[] = [];
    const uow = new DrizzleUnitOfWork(database, 5, { ...options, sleep: async (ms) => { waits.push(ms); }, backoffMs: 10 });
    let calls = 0;
    await assert.rejects(uow.transaction(async () => { calls++; throw deadlock(); }), (error: unknown) => isDeadlockError(error));
    assert.equal(calls, 3, "1 run + 2 retries");
    assert.deepEqual(waits, [10, 20], "exponential backoff between attempts");
  });

  it("does not retry other errors (business errors, lock wait timeouts)", async () => {
    const { database } = fakeDatabase();
    const uow = new DrizzleUnitOfWork(database, 5, options);
    let calls = 0;
    await assert.rejects(uow.transaction(async () => { calls++; throw new Error("business rule"); }), /business rule/);
    await assert.rejects(uow.transaction(async () => { calls++; throw Object.assign(new Error("timeout"), { errno: 1205 }); }), /timeout/);
    assert.equal(calls, 2);
  });
});
