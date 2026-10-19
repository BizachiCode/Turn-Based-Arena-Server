import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { ArenaDefense, ArenaOpponentView } from "./arena.domain.js";
import type { ArenaSeasonResult } from "./arena-season.js";

/** One player's arena profile (`arena_profiles`). */
export type ArenaProfileRecord = {
  userId: string;
  publicId: string;
  rating: number;
  wins: number;
  losses: number;
  defenseWins: number;
  defenseLosses: number;
  defense: ArenaDefense | null;
  /** Opponents currently offered (null = none yet or consumed by an attack). */
  opponents: ArenaOpponentView[] | null;
  opponentsRefreshedAt: Date | null;
  /** Season the rating belongs to (0 = not tracked yet). */
  season: number;
  /** Attacks settled during `season`. */
  seasonBattles: number;
  /** Last ended season the player fought in (null = none yet). */
  lastSeason: ArenaSeasonResult | null;
  /** True until `arena/state` returned `lastSeason` once. */
  seasonResultPending: boolean;
};

/** Moves a profile into a new season (`season_battles` restarts at 0). */
export type ArenaSeasonPatch = {
  season: number;
  rating: number;
  /** Result of the settled season (stored and flagged pending); undefined keeps the previous one. */
  lastSeason?: ArenaSeasonResult;
};

/** A real player that can be offered as opponent (has a defense team). */
export type ArenaCandidate = {
  userId: string;
  publicId: string;
  name: string;
  accountLevel: number;
  rating: number;
  defense: ArenaDefense;
};

export type ArenaBattleRecord = {
  battleId: string;
  attackerId: string;
  defenderId: string | null;
  npcId: string | null;
  attackerRatingBefore: number;
  rewardsGranted: boolean;
  result: unknown;
};

export type ArenaDefenseLogEntry = { attackerName: string; defenseWon: boolean; ratingChange: number; at: Date };

export type ArenaRankingRow = { userId: string; name: string; level: number; rating: number };

export type ArenaProfilePatch = {
  rating: number;
  winsDelta?: number;
  lossesDelta?: number;
  defenseWinsDelta?: number;
  defenseLossesDelta?: number;
  /** Attacks counted for the running season. */
  seasonBattlesDelta?: number;
};

/** Persistence port of the arena. Every player-owned query is scoped by the authenticated user id. */
export interface ArenaRepository {
  /** Creates the profile when missing (random public id) and returns it; `forUpdate` locks the row. */
  ensureProfile(userId: string, startRating: number, session?: DbSession, forUpdate?: boolean): Promise<ArenaProfileRecord>;
  /** Public lookup used to resolve an offered opponent (`u:<publicId>`). */
  findProfileByPublicId(publicId: string, session?: DbSession): Promise<ArenaProfileRecord | null>;
  /** Locks the given profiles in a stable order (no deadlocks between two battles settling together). */
  lockProfiles(userIds: string[], session: DbSession): Promise<Map<string, ArenaProfileRecord>>;
  saveDefense(userId: string, defense: ArenaDefense, session: DbSession): Promise<void>;
  /** Defense team of a player without creating a profile (null when none). */
  findDefense(userId: string, session?: DbSession): Promise<ArenaDefense | null>;
  /** `refreshedAt` undefined keeps the stored timestamp. */
  saveOpponents(userId: string, opponents: ArenaOpponentView[] | null, refreshedAt: Date | undefined, session: DbSession): Promise<void>;
  applyBattleResult(userId: string, patch: ArenaProfilePatch, session: DbSession): Promise<void>;
  /** 1 + number of profiles with a higher rating. */
  rankOf(rating: number, session?: DbSession): Promise<number>;
  topRatings(limit: number): Promise<ArenaRankingRow[]>;
  /** Players with a defense team nearest to `rating` (excluding `excludeUserIds`). */
  findCandidates(rating: number, excludeUserIds: string[], limit: number): Promise<ArenaCandidate[]>;
  /** Defenders (real players) the user attacked since `since`. */
  recentDefenderIds(attackerId: string, since: Date): Promise<string[]>;
  insertBattle(battle: { battleId: string; attackerId: string; defenderId: string | null; npcId: string | null; attackerRatingBefore: number }, session: DbSession): Promise<void>;
  /** Locks the battle row of this attacker (null when it does not exist or belongs to someone else). */
  lockBattle(battleId: string, attackerId: string, session: DbSession): Promise<ArenaBattleRecord | null>;
  finishBattle(
    battleId: string,
    outcome: { won: boolean; attackerRatingBefore: number; ratingDelta: number; defenderDelta: number; result: unknown; at: Date },
    session: DbSession,
  ): Promise<void>;
  listDefenseLog(defenderId: string, limit: number): Promise<ArenaDefenseLogEntry[]>;

  // ── Seasons ──
  /**
   * Moves the profile from season `fromSeason` to `patch.season` (rating, battle count reset, settled result).
   * Conditional on the stored season still being `fromSeason`: false when another request already moved it, so a
   * season is settled at most once per player.
   */
  rolloverSeason(userId: string, fromSeason: number, patch: ArenaSeasonPatch, session: DbSession): Promise<boolean>;
  /** Clears the "season result not shown yet" flag. */
  markSeasonResultSeen(userId: string, session: DbSession): Promise<void>;
  /** Adopts every untracked profile (season 0) into `season` without settling anything; returns how many. */
  adoptUntrackedProfiles(season: number): Promise<number>;
  /** Up to `limit` players whose profile is still in another season than `currentSeason` (sweep job). */
  listOutdatedSeasonUserIds(currentSeason: number, limit: number): Promise<string[]>;
}
