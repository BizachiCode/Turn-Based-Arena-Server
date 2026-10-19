import { and, gte, inArray, isNotNull, lt, eq, sql, type AnyColumn } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { arenaBattles, auditEvents, pveBattles, userMail, userSessions, users } from "../../infrastructure/database/schema/index.js";
import type { AdminAnalyticsRepository, AnalyticsDailyCounts } from "./admin-analytics.service.js";

const dayOf = (column: AnyColumn) => sql<string>`DATE_FORMAT(${column}, '%Y-%m-%d')`;

export class DrizzleAdminAnalyticsRepository extends DrizzleRepository implements AdminAnalyticsRepository {
  constructor(database: Database) {
    super(database);
  }

  async dailyCounts(from: Date, to: Date): Promise<AnalyticsDailyCounts> {
    const db = this.database;
    const count = sql<number>`count(*)`;
    const counts: AnalyticsDailyCounts = {};
    const fill = (metric: string, rows: Array<{ day: string; n: number | string | null }>) => {
      const days = (counts[metric] ??= {});
      for (const row of rows) days[row.day] = (days[row.day] ?? 0) + Number(row.n ?? 0);
    };

    const [accounts, logins, pve, arena, mail, shop, grants, active] = await Promise.all([
      db.select({ day: dayOf(users.createdAt), n: count }).from(users)
        .where(and(gte(users.createdAt, from), lt(users.createdAt, to))).groupBy(dayOf(users.createdAt)),
      db.select({ day: dayOf(auditEvents.createdAt), n: count }).from(auditEvents)
        .where(and(eq(auditEvents.kind, "LOGIN"), gte(auditEvents.createdAt, from), lt(auditEvents.createdAt, to)))
        .groupBy(dayOf(auditEvents.createdAt)),
      db.select({ day: dayOf(pveBattles.createdAt), n: count }).from(pveBattles)
        .where(and(inArray(pveBattles.status, ["VICTORY", "DEFEAT"]), gte(pveBattles.createdAt, from), lt(pveBattles.createdAt, to)))
        .groupBy(dayOf(pveBattles.createdAt)),
      db.select({ day: dayOf(arenaBattles.createdAt), n: count }).from(arenaBattles)
        .where(and(isNotNull(arenaBattles.finishedAt), gte(arenaBattles.createdAt, from), lt(arenaBattles.createdAt, to)))
        .groupBy(dayOf(arenaBattles.createdAt)),
      db.select({ day: dayOf(userMail.createdAt), n: count }).from(userMail)
        .where(and(gte(userMail.createdAt, from), lt(userMail.createdAt, to))).groupBy(dayOf(userMail.createdAt)),
      db.select({
        day: dayOf(auditEvents.createdAt),
        currency: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${auditEvents.meta}, '$.currencyId'))`,
        n: count,
        spent: sql<number>`coalesce(sum(JSON_EXTRACT(${auditEvents.meta}, '$.price')), 0)`,
      }).from(auditEvents)
        .where(and(eq(auditEvents.kind, "SHOP_PURCHASE"), gte(auditEvents.createdAt, from), lt(auditEvents.createdAt, to)))
        .groupBy(dayOf(auditEvents.createdAt), sql`JSON_UNQUOTE(JSON_EXTRACT(${auditEvents.meta}, '$.currencyId'))`),
      db.select({
        day: dayOf(auditEvents.createdAt),
        n: sql<number>`coalesce(sum(JSON_EXTRACT(${auditEvents.meta}, '$.amount')), 0)`,
      }).from(auditEvents)
        .where(and(eq(auditEvents.kind, "GM_GRANT_CURRENCY"), gte(auditEvents.createdAt, from), lt(auditEvents.createdAt, to)))
        .groupBy(dayOf(auditEvents.createdAt)),
      // A player counts once per day whether they logged in, connected or both.
      db.execute(sql`select day, count(*) as n from (
          select user_id, DATE_FORMAT(connected_at, '%Y-%m-%d') as day from ${userSessions}
            where connected_at >= ${from} and connected_at < ${to}
          union
          select user_id, DATE_FORMAT(created_at, '%Y-%m-%d') as day from ${auditEvents}
            where kind = 'LOGIN' and user_id is not null and created_at >= ${from} and created_at < ${to}
        ) t group by day`),
    ]);

    fill("newAccounts", accounts);
    fill("logins", logins);
    fill("pveBattles", pve);
    fill("arenaBattles", arena);
    fill("mailDelivered", mail);
    fill("gmCurrencyGranted", grants);
    fill("shopPurchases", shop);
    for (const row of shop) {
      if (row.currency) fill(`shopSpent:${row.currency}`, [{ day: row.day, n: row.spent }]);
    }
    fill("activePlayers", (active as unknown as [Array<{ day: string; n: number | string }>])[0] ?? []);
    return counts;
  }

  async distinctActive(from: Date, to: Date): Promise<number> {
    const result = await this.database.execute(sql`select count(*) as n from (
        select user_id from ${userSessions} where connected_at >= ${from} and connected_at < ${to}
        union
        select user_id from ${auditEvents} where kind = 'LOGIN' and user_id is not null and created_at >= ${from} and created_at < ${to}
      ) t`);
    const rows = (result as unknown as [Array<{ n: number | string }>])[0];
    return Number(rows?.[0]?.n ?? 0);
  }

  async totalAccounts(): Promise<number> {
    const [row] = await this.database.select({ n: sql<number>`count(*)` }).from(users);
    return Number(row?.n ?? 0);
  }
}
