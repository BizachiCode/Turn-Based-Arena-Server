// Daily retention job: archives old refresh-token/audit logs as gzipped NDJSON, deletes them,
// purges expired refresh tokens, old stage battle rows (`pve_battles`) and the stored purchase responses
// of old shop purchases, old server log entries and the stored responses of idempotent requests.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { Database } from "../database/drizzle.js";
import { affectedRows } from "../database/drizzle-unit-of-work.js";
import { auditEvents, pveBattles, serverLogs, userRefreshTokenLog, userRefreshTokens, userRequestResults, userShopPurchases } from "../database/schema/index.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("RetentionJob");
const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionOptions = {
  refreshLogDays: number;
  auditDays: number;
  exportDir: string;
  batchSize?: number;
  /** Unused stage tickets (`pve_battles.status = TICKET`) older than this are deleted (default 1; tickets live minutes). */
  pveTicketDays?: number;
  /** Abandoned (`STARTED` / `EXPIRED`) stage battles older than this are deleted (default 14). */
  pveStaleDays?: number;
  /**
   * Settled stage battles (`VICTORY` / `DEFEAT`) older than this are deleted (default 90, the longest window of the
   * GM analytics, which counts them).
   */
  pveFinishedDays?: number;
  /**
   * Shop purchases older than this lose their stored response and idempotency key (the row stays: it is the history
   * that purchase limits and the player audit read). Default 30; a retry with the same purchase id after that is a
   * new purchase.
   */
  shopPurchaseResponseDays?: number;
  /** `server_logs` entries (GM panel Logs) older than this are deleted (default 14). */
  serverLogDays?: number;
  /** Stored responses of idempotent requests (`user_request_results`) older than this are deleted (default 7). */
  requestResultDays?: number;
};

export class RetentionJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: Database,
    private readonly options: RetentionOptions,
  ) {}

  /** Runs once a day at `hour:minute` (server local time). */
  schedule(hour = 3, minute = 33): void {
    const now = new Date();
    const first = new Date(now);
    first.setHours(hour, minute, 0, 0);
    if (first.getTime() <= now.getTime()) first.setDate(first.getDate() + 1);

    this.timer = setTimeout(() => {
      void this.runSafely();
      this.timer = setInterval(() => void this.runSafely(), DAY_MS);
    }, first.getTime() - now.getTime());
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runSafely(): Promise<void> {
    try {
      await this.run();
      logger.info("rotation/cleanup done");
    } catch (error) {
      logger.error("run failed:", error);
    }
  }

  async run(): Promise<void> {
    const batch = this.options.batchSize ?? 5_000;
    const day = (days: number) => new Date(Date.now() - Math.max(1, days) * DAY_MS);
    const stamp = new Date().toISOString().slice(0, 10);

    for (;;) {
      const rows = await this.database.select().from(userRefreshTokenLog)
        .where(lt(userRefreshTokenLog.at, day(this.options.refreshLogDays))).orderBy(asc(userRefreshTokenLog.id)).limit(batch);
      if (rows.length === 0) break;
      await this.appendNdjsonGz(path.join(this.options.exportDir, `refresh_logs_${stamp}.ndjson.gz`), rows);
      await this.database.delete(userRefreshTokenLog).where(inArray(userRefreshTokenLog.id, rows.map((row) => row.id)));
    }

    for (;;) {
      const rows = await this.database.select().from(auditEvents)
        .where(lt(auditEvents.createdAt, day(this.options.auditDays))).orderBy(asc(auditEvents.id)).limit(batch);
      if (rows.length === 0) break;
      await this.appendNdjsonGz(path.join(this.options.exportDir, `audit_events_${stamp}.ndjson.gz`), rows);
      await this.database.delete(auditEvents).where(inArray(auditEvents.id, rows.map((row) => row.id)));
    }

    await this.database.delete(userRefreshTokens).where(and(
      or(eq(userRefreshTokens.isRevoked, 1), lt(userRefreshTokens.expiresAt, new Date())),
      lt(userRefreshTokens.issuedAt, day(this.options.refreshLogDays)),
    ));

    await this.purgeGameplayTables(batch, day);
    await this.purgeOperationalTables(batch, day);
  }

  /** Server logs and idempotency results. Failures are logged (to the memory ring buffer too) and never block the rest. */
  private async purgeOperationalTables(batch: number, day: (days: number) => Date): Promise<void> {
    const targets = [
      { label: "server_logs", cutoff: day(this.options.serverLogDays ?? 14), purge: (cutoff: Date) => this.database.delete(serverLogs).where(lt(serverLogs.createdAt, cutoff)).limit(batch) },
      { label: "user_request_results", cutoff: day(this.options.requestResultDays ?? 7), purge: (cutoff: Date) => this.database.delete(userRequestResults).where(lt(userRequestResults.createdAt, cutoff)).limit(batch) },
    ];
    for (const { label, cutoff, purge } of targets) {
      try {
        for (;;) {
          const removed = affectedRows(await purge(cutoff));
          if (removed < batch) break;
        }
      } catch (error) {
        logger.error(`purging ${label} failed:`, error);
      }
    }
  }

  /** Bounded tables of the stage battles and the shop. Failures are logged and do not block the other purges. */
  private async purgeGameplayTables(batch: number, day: (days: number) => Date): Promise<void> {
    const options = this.options;
    const tickets = and(eq(pveBattles.status, "TICKET"), lt(pveBattles.createdAt, day(options.pveTicketDays ?? 1)));
    const stale = and(inArray(pveBattles.status, ["STARTED", "EXPIRED"]), lt(pveBattles.createdAt, day(options.pveStaleDays ?? 14)));
    const settled = and(inArray(pveBattles.status, ["VICTORY", "DEFEAT"]), lt(pveBattles.createdAt, day(options.pveFinishedDays ?? 90)));

    for (const [label, where] of [["unused tickets", tickets], ["abandoned battles", stale], ["settled battles", settled]] as const) {
      try {
        for (;;) {
          const removed = affectedRows(await this.database.delete(pveBattles).where(where).limit(batch));
          if (removed < batch) break;
        }
      } catch (error) {
        logger.error(`purging pve_battles ${label} failed:`, error);
      }
    }

    try {
      const cutoff = day(options.shopPurchaseResponseDays ?? 30);
      for (;;) {
        const updated = affectedRows(await this.database.update(userShopPurchases)
          .set({ response: null, purchaseId: null })
          .where(and(lt(userShopPurchases.createdAt, cutoff), or(isNotNull(userShopPurchases.response), isNotNull(userShopPurchases.purchaseId))))
          .limit(batch));
        if (updated < batch) break;
      }
    } catch (error) {
      logger.error("purging user_shop_purchases responses failed:", error);
    }
  }

  private async appendNdjsonGz(filePath: string, rows: unknown[]): Promise<void> {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const source = new PassThrough();
    for (const row of rows) source.write(JSON.stringify(row) + "\n");
    source.end();
    await pipeline(source, zlib.createGzip(), fs.createWriteStream(filePath, { flags: "a" }));
  }
}
