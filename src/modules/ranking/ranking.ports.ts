import type { PlayerMetric } from "./ranking.domain.js";

/** A player's score in a metric (`value` is what the client shows, `score` is what orders the list). */
export type RankingScoreRow = { userId: string; value: number; score: number };

/** The caller's own standing: its score and how many players are strictly ahead. */
export type RankingStanding = { value: number; score: number; better: number };

/** Public card of a player (never contains the internal user id). */
export type RankingProfile = { displayName: string; iconId: string; level: number; guildTag: string | null };

export type GuildScoreRow = { guildId: string; name: string; iconId: string; memberCount: number; value: number };

export type GuildStanding = { row: GuildScoreRow; better: number };

/**
 * Read-only persistence port of the leaderboards. Everything is computed from the gameplay tables; banned players are
 * left out. `topScores` / `topGuilds` are the heavy queries (the service caches them); `standing` / `guildStanding`
 * are bounded per-player lookups.
 */
export interface RankingRepository {
  /** Best `limit` players of the metric, highest score first (players with nothing to rank are excluded). */
  topScores(metric: PlayerMetric, limit: number): Promise<RankingScoreRow[]>;
  /** The player's score and the number of players ahead; null when the player has nothing to rank. */
  standing(metric: PlayerMetric, userId: string): Promise<RankingStanding | null>;
  /** Name, icon, level and guild name of the players. */
  profiles(userIds: string[]): Promise<Map<string, RankingProfile>>;
  /** Best `limit` guilds by activity points of the week. */
  topGuilds(weekKey: string, limit: number): Promise<GuildScoreRow[]>;
  /** The player's guild with its points of the week and the guilds ahead; null when not in a guild. */
  guildStanding(userId: string, weekKey: string): Promise<GuildStanding | null>;
}
