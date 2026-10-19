// Calendar helpers for content that resets once a day at a configurable UTC hour (dungeon schedules, missions...).

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Start (UTC) of the game day containing `now`; days start at `resetHourUtc`. */
export function gameDayStart(now: Date, resetHourUtc: number): Date {
  const shifted = new Date(now.getTime() - resetHourUtc * HOUR_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + resetHourUtc * HOUR_MS);
}

/** Weekday (0 = Sunday .. 6 = Saturday) of the game day containing `now`. */
export function gameWeekday(now: Date, resetHourUtc: number): number {
  return new Date(now.getTime() - resetHourUtc * HOUR_MS).getUTCDay();
}

/** Start of the next game day. */
export function nextGameDay(now: Date, resetHourUtc: number): Date {
  return new Date(gameDayStart(now, resetHourUtc).getTime() + DAY_MS);
}

/** `YYYY-MM-DD` of the game day containing `now` (stable key for per-day progress). */
export function gameDayKey(now: Date, resetHourUtc: number): string {
  const day = new Date(now.getTime() - resetHourUtc * HOUR_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
}
