// PvP arena: one profile per player (rating, season, defense team, cached opponent list) and one row per arena battle.
import { mysqlTable, char, varchar, int, tinyint, text, datetime, json, mysqlEnum, uniqueIndex, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { users } from "./accounts.schema";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const arenaProfiles = mysqlTable("arena_profiles", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Random public handle used in opponent ids (`u:<publicId>`); internal user ids are never sent to other players. */
  publicId: char("public_id", { length: 16 }).notNull(),
  rating: int("rating").notNull().default(1000),
  wins: int("wins").notNull().default(0),
  losses: int("losses").notNull().default(0),
  defenseWins: int("defense_wins").notNull().default(0),
  defenseLosses: int("defense_losses").notNull().default(0),
  /** `{ uidsInSlots, leaderSlotIndex }` of the defense team (null = no defense: cannot be attacked). */
  defenseJson: text("defense_json"),
  /** Opponent list currently offered to the player (null = none / consumed by an attack). */
  opponentsJson: text("opponents_json"),
  opponentsRefreshedAt: datetime("opponents_refreshed_at"),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
  /** Season the rating and `season_battles` belong to (0 = not tracked yet: adopted into the running season). */
  season: int("season").notNull().default(0),
  /** Attacks settled during `season` (season rewards need `seasons.minBattles`). */
  seasonBattles: int("season_battles").notNull().default(0),
  /** Result of the last ended season the player fought in (tier, rating, rewards; see `ArenaSeasonResult`). */
  lastSeasonJson: text("last_season_json"),
  /** 1 until `arena/state` returned `last_season_json` once (the client toasts it). */
  seasonResultPending: tinyint("season_result_pending").notNull().default(0),
}, (t) => [
  uniqueIndex("uq_arena_public_id").on(t.publicId),
  index("idx_arena_rating").on(t.rating),
  index("idx_arena_season").on(t.season),
]);

/**
 * One row per arena battle, created in the transaction that spends the Arena Wing. The final frame settles it
 * exactly once (`rewards_granted`): rating changes, rewards and the stored `result_json` replayed on retries.
 */
export const arenaBattles = mysqlTable("arena_battles", {
  battleId: char("battle_id", { length: 26 }).primaryKey().notNull(),
  attackerId: char("attacker_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Null for NPC rivals. */
  defenderId: char("defender_id", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
  npcId: varchar("npc_id", { length: 64 }),
  attackerRatingBefore: int("attacker_rating_before").notNull(),
  /** Attacker rating change (win positive, loss negative, after the floor at 0). */
  ratingDelta: int("rating_delta").notNull().default(0),
  /** Defender rating change (mirror of the attacker's, clamped at 0); 0 for NPC rivals. */
  defenderDelta: int("defender_delta").notNull().default(0),
  result: mysqlEnum("result", ["win", "loss"]),
  rewardsGranted: tinyint("rewards_granted").notNull().default(0),
  resultJson: json("result_json"),
  createdAt: datetime("created_at").notNull().default(now),
  finishedAt: datetime("finished_at"),
}, (t) => [
  index("idx_arena_battle_attacker").on(t.attackerId, t.createdAt),
  index("idx_arena_battle_defender").on(t.defenderId, t.createdAt),
]);
