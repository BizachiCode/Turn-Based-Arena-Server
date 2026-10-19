import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Progress of one daily quest in one period. */
export type GuildQuestProgressRow = { questId: string; progress: number; claimedAt: Date | null };

/** A member's points in the current week, with the profile shown in the contributors list. */
export type GuildContributorRow = { userId: string; name: string; level: number; iconId: string; points: number };

/** Persistence port of the guild quests (daily progress, weekly activity points, chest claims). */
export interface GuildQuestRepository {
  listProgress(userId: string, periodKey: string, session?: DbSession): Promise<GuildQuestProgressRow[]>;
  /** Adds `amount` to each quest's progress (capped at its target), creating missing rows. */
  addProgress(userId: string, periodKey: string, quests: Array<{ questId: string; target: number }>, amount: number): Promise<void>;
  lockProgress(userId: string, questId: string, periodKey: string, session: DbSession): Promise<GuildQuestProgressRow | null>;
  markQuestClaimed(userId: string, questId: string, periodKey: string, at: Date, session: DbSession): Promise<void>;
  /** Drops progress rows of periods before `beforePeriodKey` (keys sort chronologically). */
  deleteProgressBefore(userId: string, beforePeriodKey: string): Promise<void>;

  addActivity(guildId: string, weekKey: string, userId: string, points: number, session: DbSession): Promise<void>;
  /** Total points of the guild in the week. */
  guildPoints(guildId: string, weekKey: string, session?: DbSession): Promise<number>;
  /** The player's points in the guild this week. */
  memberPoints(guildId: string, weekKey: string, userId: string): Promise<number>;
  /** Members with points this week, most points first (players who left the guild still count for the total). */
  contributors(guildId: string, weekKey: string, limit: number): Promise<GuildContributorRow[]>;

  listChestClaims(userId: string, weekKey: string, session?: DbSession): Promise<Set<string>>;
  /** Throws a duplicate-key error when the chest was already claimed this week. */
  insertChestClaim(userId: string, weekKey: string, chestId: string, guildId: string, session: DbSession): Promise<void>;
}
