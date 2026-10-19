// Pure guild quest rules (mirrored by the Unity offline backend `GuildQuestRules`): daily/weekly period keys and
// reset times. Periods start at `resetHourUtc`; weeks start on `weekStartsOn` (0 = Sunday).

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const pad = (value: number) => String(value).padStart(2, "0");
const isoDay = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** Start (UTC) of the daily period that contains `now`. */
export function dayStart(now: Date, resetHourUtc: number): Date {
  const shifted = new Date(now.getTime() - resetHourUtc * HOUR_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + resetHourUtc * HOUR_MS);
}

/** Start (UTC) of the week that contains `now`. */
export function weekStart(now: Date, resetHourUtc: number, weekStartsOn: number): Date {
  const day = dayStart(now, resetHourUtc);
  const shiftedDay = new Date(day.getTime() - resetHourUtc * HOUR_MS);
  const offset = (shiftedDay.getUTCDay() - weekStartsOn + 7) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

/** `D:2026-10-11`: key of the daily quest period. */
export function dayKey(now: Date, resetHourUtc: number): string {
  return `D:${isoDay(new Date(dayStart(now, resetHourUtc).getTime() - resetHourUtc * HOUR_MS))}`;
}

/** `W:2026-10-05`: key of the chest week (date of its first day). */
export function weekKey(now: Date, resetHourUtc: number, weekStartsOn: number): string {
  return `W:${isoDay(new Date(weekStart(now, resetHourUtc, weekStartsOn).getTime() - resetHourUtc * HOUR_MS))}`;
}

export function nextDailyReset(now: Date, resetHourUtc: number): Date {
  return new Date(dayStart(now, resetHourUtc).getTime() + DAY_MS);
}

export function nextWeeklyReset(now: Date, resetHourUtc: number, weekStartsOn: number): Date {
  return new Date(weekStart(now, resetHourUtc, weekStartsOn).getTime() + 7 * DAY_MS);
}

/** Daily progress rows older than this many days are pruned. */
export const QUEST_PROGRESS_RETENTION_DAYS = 7;
