// Pure arena season rules (mirrored by the Unity `ArenaSeasonRules` / `OfflineArenaService`, see docs/ARENA.md
// "Seasons"): season window from the anchor, tier of a rating, soft reset and what a season rollover does.

import type { ArenaSeasonsConfig, ArenaSeasonTier } from "../../config/ArenaCatalog.js";
import type { CurrencyAmount } from "../../shared/kernel/types.js";

export const DAY_MS = 86_400_000;

/** One season: `number` 1 starts at the anchor; times are unix ms (`endsAt` exclusive). */
export type ArenaSeasonWindow = { number: number; startsAt: number; endsAt: number };

/** UTC instant of `seasons.anchor` (validated by the catalog) in unix ms. */
export function seasonAnchorMs(seasons: Pick<ArenaSeasonsConfig, "anchor">): number {
  return Date.parse(seasons.anchor);
}

/**
 * Season running at `nowMs`. Seasons follow each other every `lengthDays` from the anchor; before the anchor the
 * first season is running (it ends at anchor + length).
 */
export function seasonAt(nowMs: number, anchorMs: number, lengthDays: number): ArenaSeasonWindow {
  const length = lengthDays * DAY_MS;
  const index = Math.max(0, Math.floor((nowMs - anchorMs) / length));
  const startsAt = anchorMs + index * length;
  return { number: index + 1, startsAt, endsAt: startsAt + length };
}

/** Index of the highest tier whose `minRating` is <= `rating` (tiers sorted ascending, the first starts at 0). */
export function tierIndexFor(rating: number, tiers: readonly { minRating: number }[]): number {
  let index = 0;
  for (let i = 0; i < tiers.length; i += 1) if (rating >= tiers[i].minRating) index = i;
  return index;
}

/** Soft reset of a new season: `max(floor, base + round((rating - base) * keepPercent / 100))` (JS rounding). */
export function softResetRating(rating: number, reset: { base: number; keepPercent: number; floor: number }): number {
  const next = reset.base + Math.round(((rating - reset.base) * reset.keepPercent) / 100);
  return Math.max(reset.floor, next) + 0; // + 0 turns -0 into 0
}

/** Profile fields the season rules look at. `season` 0 = not tracked yet (profiles created before seasons existed). */
export type ArenaSeasonStanding = { season: number; rating: number; seasonBattles: number };

/** Result of an ended season the player fought in (stored on the profile, shown once by `arena/state`). */
export type ArenaSeasonResult = {
  season: number;
  tierId: string;
  /** Final rating of the season. */
  rating: number;
  /** Attacks of the season. */
  battles: number;
  /** Tier rewards (mailed). */
  rewards: CurrencyAmount[];
  /** Rating after the soft reset(s). */
  ratingAfter: number;
  /** True when the reward mail was sent. */
  mailed: boolean;
  /** Unix ms. */
  settledAt: number;
};

export type ArenaSeasonRollover = {
  /** Season the profile moves to (the running one). */
  season: number;
  ratingAfter: number;
  /** The ended season (null when the profile is only adopted into the running season). */
  settled: { season: number; tier: ArenaSeasonTier; rating: number; battles: number; rewarded: boolean } | null;
};

/**
 * What happens to a profile while season `current` is running (null = nothing, it is already current):
 * - untracked (season 0) or from a "future" season (the anchor/length was changed): adopted into `current`, rating
 *   kept, nothing settled;
 * - otherwise its season is settled with the current rating (`rewarded` with at least `minBattles` attacks) and the
 *   soft reset is applied once per season boundary crossed: seasons skipped without playing only reset the rating.
 */
export function planSeasonRollover(standing: ArenaSeasonStanding, current: number, seasons: ArenaSeasonsConfig): ArenaSeasonRollover | null {
  if (standing.season === current) return null;
  if (standing.season <= 0 || standing.season > current) return { season: current, ratingAfter: standing.rating, settled: null };

  const tier = seasons.tiers[tierIndexFor(standing.rating, seasons.tiers)];
  let rating = standing.rating;
  for (let boundary = standing.season; boundary < current; boundary += 1) {
    const next = softResetRating(rating, seasons.reset);
    if (next === rating) break; // fixed point: further resets change nothing
    rating = next;
  }
  return {
    season: current,
    ratingAfter: rating,
    settled: {
      season: standing.season,
      tier,
      rating: standing.rating,
      battles: standing.seasonBattles,
      rewarded: standing.seasonBattles >= seasons.minBattles,
    },
  };
}

/** Rewards of a tier with the empty entries dropped. */
export function tierRewards(tier: ArenaSeasonTier): CurrencyAmount[] {
  return tier.rewards.filter((entry) => entry.amount > 0).map((entry) => ({ currencyId: entry.currencyId, amount: entry.amount }));
}

/** Display name of a tier (its id when no name is configured). */
export function tierName(tier: ArenaSeasonTier): string {
  return tier.name.trim() || tier.id;
}
