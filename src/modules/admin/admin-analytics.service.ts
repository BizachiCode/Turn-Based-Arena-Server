// GM panel "Overview": daily series and period totals computed from the tables the game already keeps (accounts,
// presence sessions, login audit, battles, mail, shop audit). Nothing is recorded just for analytics.

import type { Clock } from "../../shared/kernel/clock.js";

/** Metrics a repository reports per day (`shopSpent:<currencyId>` carries the currency in the key). */
export const ANALYTICS_METRICS = [
  "newAccounts",
  "activePlayers",
  "logins",
  "pveBattles",
  "arenaBattles",
  "mailDelivered",
  "shopPurchases",
  "gmCurrencyGranted",
] as const;
export type AnalyticsMetric = typeof ANALYTICS_METRICS[number];

/** Day (`YYYY-MM-DD`, database clock) -> value, per metric. */
export type AnalyticsDailyCounts = Record<string, Record<string, number>>;

export interface AdminAnalyticsRepository {
  /** Daily counts of every metric for `from` (inclusive) .. `to` (exclusive). */
  dailyCounts(from: Date, to: Date): Promise<AnalyticsDailyCounts>;
  /** Distinct players that logged in or connected in the period. */
  distinctActive(from: Date, to: Date): Promise<number>;
  totalAccounts(): Promise<number>;
}

export type AnalyticsTotal = { value: number; previous: number; delta: number };

export type AdminAnalytics = {
  days: number;
  /** One entry per day, oldest first (`YYYY-MM-DD`). */
  dates: string[];
  series: Record<AnalyticsMetric | "battles" | "shopSpent", number[]>;
  /** Currency the `shopSpent` series is expressed in (the most spent one of the period; null when no purchases). */
  shopSpentCurrency: string | null;
  totals: Record<AnalyticsMetric | "battles" | "shopSpent", AnalyticsTotal>;
  totalAccounts: number;
};

const DAY_MS = 24 * 3600 * 1000;
const SHOP_SPENT = "shopSpent:";
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

export class AdminAnalyticsService {
  constructor(private readonly deps: { repo: AdminAnalyticsRepository; clock: Clock }) {}

  /** `days` is clamped to 1..90. The previous period has the same length and ends the day before the first day. */
  async overview(days: number): Promise<AdminAnalytics> {
    const length = Math.max(1, Math.min(90, Math.floor(days) || 7));
    const now = this.deps.clock.now();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const start = todayStart - (length - 1) * DAY_MS;
    const previousStart = start - length * DAY_MS;
    const end = todayStart + DAY_MS;

    const [counts, active, previousActive, totalAccounts] = await Promise.all([
      this.deps.repo.dailyCounts(new Date(previousStart), new Date(end)),
      this.deps.repo.distinctActive(new Date(start), new Date(end)),
      this.deps.repo.distinctActive(new Date(previousStart), new Date(start)),
      this.deps.repo.totalAccounts(),
    ]);

    const dates = Array.from({ length }, (_, index) => dayKey(new Date(start + index * DAY_MS)));
    const previousDates = Array.from({ length }, (_, index) => dayKey(new Date(previousStart + index * DAY_MS)));
    const pick = (metric: string, keys: string[]) => keys.map((key) => counts[metric]?.[key] ?? 0);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

    // The shop spends several currencies: the series follows the one with the largest period total.
    const spentTotals = Object.keys(counts).filter((key) => key.startsWith(SHOP_SPENT))
      .map((key) => ({ key, total: sum(pick(key, dates)) })).filter((entry) => entry.total > 0).sort((a, b) => b.total - a.total);
    const spentKey = spentTotals[0]?.key ?? null;

    const current: Record<string, number[]> = {};
    const previous: Record<string, number[]> = {};
    for (const metric of ANALYTICS_METRICS) {
      current[metric] = pick(metric, dates);
      previous[metric] = pick(metric, previousDates);
    }
    current.battles = current.pveBattles.map((value, index) => value + current.arenaBattles[index]);
    previous.battles = previous.pveBattles.map((value, index) => value + previous.arenaBattles[index]);
    current.shopSpent = spentKey ? pick(spentKey, dates) : dates.map(() => 0);
    previous.shopSpent = spentKey ? pick(spentKey, previousDates) : previousDates.map(() => 0);

    const totals: Record<string, AnalyticsTotal> = {};
    for (const metric of Object.keys(current)) {
      const value = metric === "activePlayers" ? active : sum(current[metric]);
      const before = metric === "activePlayers" ? previousActive : sum(previous[metric]);
      totals[metric] = { value, previous: before, delta: value - before };
    }

    return {
      days: length,
      dates,
      series: current as AdminAnalytics["series"],
      shopSpentCurrency: spentKey ? spentKey.slice(SHOP_SPENT.length) : null,
      totals: totals as AdminAnalytics["totals"],
      totalAccounts,
    };
  }
}
