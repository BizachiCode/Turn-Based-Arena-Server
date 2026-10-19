import assert from "node:assert/strict";

import { getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

import type { Database } from "../src/infrastructure/database/drizzle";
import { RetentionJob } from "../src/infrastructure/maintenance/retention.job";

type Op = { kind: "select" | "delete" | "update"; table: string; where: { sql: string; params: unknown[] } | null; limit: number | null; set: unknown };

/** Records the query builder calls; every delete / update reports 0 affected rows so the batch loops stop. */
function recordingDatabase() {
  const dialect = new MySqlDialect();
  const ops: Op[] = [];
  const make = (kind: Op["kind"], table: unknown) => {
    const op: Op = { kind, table: table ? getTableName(table as never) : "", where: null, limit: null, set: null };
    ops.push(op);
    const chain: Record<string, unknown> = {
      from: (t: unknown) => { op.table = getTableName(t as never); return chain; },
      set: (values: unknown) => { op.set = values; return chain; },
      where: (condition: never) => { const q = dialect.sqlToQuery(condition); op.where = { sql: q.sql, params: q.params }; return chain; },
      orderBy: () => chain,
      limit: (n: number) => { op.limit = n; return chain; },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(kind === "select" ? [] : [{ affectedRows: 0 }]).then(resolve, reject),
    };
    return chain;
  };
  const database = {
    select: () => make("select", null),
    delete: (table: unknown) => make("delete", table),
    update: (table: unknown) => make("update", table),
  } as unknown as Database;
  return { database, ops };
}

describe("RetentionJob: stage battles and shop purchases", () => {
  it("purges unused tickets, abandoned and settled battles, and strips old purchase responses", async () => {
    const { database, ops } = recordingDatabase();
    const job = new RetentionJob(database, { refreshLogDays: 30, auditDays: 90, exportDir: "unused", batchSize: 500 });
    const before = Date.now();
    await job.run();

    const pve = ops.filter((op) => op.kind === "delete" && op.table === "pve_battles");
    assert.equal(pve.length, 3);
    assert.ok(pve.every((op) => op.limit === 500), "deleted in batches");
    const statuses = (op: Op) => op.where!.params.filter((param) => typeof param === "string" && /^[A-Z]+$/.test(param));
    assert.deepEqual(pve.map(statuses), [["TICKET"], ["STARTED", "EXPIRED"], ["VICTORY", "DEFEAT"]]);

    const ageDays = (op: Op) => {
      const date = op.where!.params.find((param) => param instanceof Date || (typeof param === "string" && /^\d{4}-\d\d-\d\d/.test(param)));
      const ms = date instanceof Date ? date.getTime() : new Date(`${String(date).replace(" ", "T")}Z`).getTime(); // drizzle formats datetimes in UTC
      return Math.round((before - ms) / 86_400_000);
    };
    assert.deepEqual(pve.map(ageDays), [1, 14, 90]);

    const shop = ops.find((op) => op.kind === "update" && op.table === "user_shop_purchases")!;
    assert.deepEqual(shop.set, { response: null, purchaseId: null }, "rows stay (history, purchase limits), only the replay payload goes");
    assert.equal(shop.limit, 500);
    assert.ok(!ops.some((op) => op.kind === "delete" && op.table === "user_shop_purchases"));
    assert.equal(ageDays(shop), 30);
  });

  it("keeps going when one purge fails", async () => {
    const { database, ops } = recordingDatabase();
    const realDelete = (database as unknown as { delete: (table: unknown) => unknown }).delete;
    let failed = false;
    (database as unknown as { delete: unknown }).delete = (table: unknown) => {
      const chain = realDelete(table) as { limit: (n: number) => unknown };
      if (!failed && getTableName(table as never) === "pve_battles") {
        failed = true;
        chain.limit = () => Promise.reject(new Error("db down"));
      }
      return chain;
    };
    await new RetentionJob(database, { refreshLogDays: 30, auditDays: 90, exportDir: "unused" }).run();
    assert.ok(ops.some((op) => op.kind === "update" && op.table === "user_shop_purchases"), "the shop purge still ran");
  });
});
