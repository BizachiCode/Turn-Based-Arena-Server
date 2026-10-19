import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { arenaBattles, arenaProfiles, userProfile } from "../../infrastructure/database/schema/index.js";
import type { ArenaDefense, ArenaOpponentView } from "./arena.domain.js";
import type { ArenaSeasonResult } from "./arena-season.js";
import type {
  ArenaBattleRecord,
  ArenaCandidate,
  ArenaDefenseLogEntry,
  ArenaProfilePatch,
  ArenaProfileRecord,
  ArenaRankingRow,
  ArenaRepository,
  ArenaSeasonPatch,
} from "./arena.ports.js";

const profileColumns = {
  userId: arenaProfiles.userId,
  publicId: arenaProfiles.publicId,
  rating: arenaProfiles.rating,
  wins: arenaProfiles.wins,
  losses: arenaProfiles.losses,
  defenseWins: arenaProfiles.defenseWins,
  defenseLosses: arenaProfiles.defenseLosses,
  defenseJson: arenaProfiles.defenseJson,
  opponentsJson: arenaProfiles.opponentsJson,
  opponentsRefreshedAt: arenaProfiles.opponentsRefreshedAt,
  season: arenaProfiles.season,
  seasonBattles: arenaProfiles.seasonBattles,
  lastSeasonJson: arenaProfiles.lastSeasonJson,
  seasonResultPending: arenaProfiles.seasonResultPending,
};

type ProfileRow = { [K in keyof typeof profileColumns]: (typeof profileColumns)[K]["_"]["data"] };

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Defense team as stored; malformed rows read as "no defense". */
export function parseDefense(value: unknown): ArenaDefense | null {
  const raw = parseJson(value) as { uidsInSlots?: unknown; leaderSlotIndex?: unknown } | null;
  if (!raw || !Array.isArray(raw.uidsInSlots) || !Number.isInteger(raw.leaderSlotIndex)) return null;
  return {
    uidsInSlots: raw.uidsInSlots.map((uid) => String(uid ?? "")),
    leaderSlotIndex: raw.leaderSlotIndex as number,
  };
}

/** Stored season result; malformed rows read as "none". */
function parseSeasonResult(value: unknown): ArenaSeasonResult | null {
  const raw = parseJson(value) as Partial<ArenaSeasonResult> | null;
  if (!raw || !Number.isInteger(raw.season) || typeof raw.tierId !== "string") return null;
  return {
    season: raw.season as number,
    tierId: raw.tierId,
    rating: Number(raw.rating ?? 0),
    battles: Number(raw.battles ?? 0),
    rewards: Array.isArray(raw.rewards) ? raw.rewards.map((entry) => ({ currencyId: String(entry.currencyId), amount: Number(entry.amount) })) : [],
    ratingAfter: Number(raw.ratingAfter ?? 0),
    mailed: raw.mailed === true,
    settledAt: Number(raw.settledAt ?? 0),
  };
}

function toProfile(row: ProfileRow): ArenaProfileRecord {
  const opponents = parseJson(row.opponentsJson);
  return {
    userId: row.userId,
    publicId: row.publicId,
    rating: row.rating,
    wins: row.wins,
    losses: row.losses,
    defenseWins: row.defenseWins,
    defenseLosses: row.defenseLosses,
    defense: parseDefense(row.defenseJson),
    opponents: Array.isArray(opponents) ? (opponents as ArenaOpponentView[]) : null,
    opponentsRefreshedAt: row.opponentsRefreshedAt ?? null,
    season: row.season,
    seasonBattles: row.seasonBattles,
    lastSeason: parseSeasonResult(row.lastSeasonJson),
    seasonResultPending: row.seasonResultPending === 1,
  };
}

const newPublicId = () => randomBytes(8).toString("hex");

export class DrizzleArenaRepository extends DrizzleRepository implements ArenaRepository {
  constructor(database: Database, private readonly publicIdFactory: () => string = newPublicId) {
    super(database);
  }

  async ensureProfile(userId: string, startRating: number, session?: DbSession, forUpdate = false): Promise<ArenaProfileRecord> {
    const db = this.db(session);
    await db.insert(arenaProfiles).ignore().values({ userId, publicId: this.publicIdFactory(), rating: startRating });

    const query = db.select(profileColumns).from(arenaProfiles).where(eq(arenaProfiles.userId, userId)).limit(1);
    const [row] = await (forUpdate ? query.for("update") : query);
    if (!row) throw new Error("arena profile could not be created");
    return toProfile(row);
  }

  async findProfileByPublicId(publicId: string, session?: DbSession): Promise<ArenaProfileRecord | null> {
    const [row] = await this.db(session).select(profileColumns).from(arenaProfiles).where(eq(arenaProfiles.publicId, publicId)).limit(1);
    return row ? toProfile(row) : null;
  }

  async lockProfiles(userIds: string[], session: DbSession): Promise<Map<string, ArenaProfileRecord>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db(session).select(profileColumns).from(arenaProfiles)
      .where(inArray(arenaProfiles.userId, userIds)).orderBy(asc(arenaProfiles.userId)).for("update");
    return new Map(rows.map((row) => [row.userId, toProfile(row)]));
  }

  async findDefense(userId: string, session?: DbSession): Promise<ArenaDefense | null> {
    const [row] = await this.db(session).select({ defenseJson: arenaProfiles.defenseJson }).from(arenaProfiles)
      .where(eq(arenaProfiles.userId, userId)).limit(1);
    return row ? parseDefense(row.defenseJson) : null;
  }

  async saveDefense(userId: string, defense: ArenaDefense, session: DbSession): Promise<void> {
    await this.db(session).update(arenaProfiles)
      .set({ defenseJson: JSON.stringify({ uidsInSlots: defense.uidsInSlots, leaderSlotIndex: defense.leaderSlotIndex }) })
      .where(eq(arenaProfiles.userId, userId));
  }

  async saveOpponents(userId: string, opponents: ArenaOpponentView[] | null, refreshedAt: Date | undefined, session: DbSession): Promise<void> {
    await this.db(session).update(arenaProfiles)
      .set({
        opponentsJson: opponents ? JSON.stringify(opponents) : null,
        ...(refreshedAt ? { opponentsRefreshedAt: refreshedAt } : {}),
      })
      .where(eq(arenaProfiles.userId, userId));
  }

  async applyBattleResult(userId: string, patch: ArenaProfilePatch, session: DbSession): Promise<void> {
    await this.db(session).update(arenaProfiles)
      .set({
        rating: patch.rating,
        wins: sql`${arenaProfiles.wins} + ${patch.winsDelta ?? 0}`,
        losses: sql`${arenaProfiles.losses} + ${patch.lossesDelta ?? 0}`,
        defenseWins: sql`${arenaProfiles.defenseWins} + ${patch.defenseWinsDelta ?? 0}`,
        defenseLosses: sql`${arenaProfiles.defenseLosses} + ${patch.defenseLossesDelta ?? 0}`,
        seasonBattles: sql`${arenaProfiles.seasonBattles} + ${patch.seasonBattlesDelta ?? 0}`,
      })
      .where(eq(arenaProfiles.userId, userId));
  }

  async rolloverSeason(userId: string, fromSeason: number, patch: ArenaSeasonPatch, session: DbSession): Promise<boolean> {
    const result = await this.db(session).update(arenaProfiles)
      .set({
        season: patch.season,
        rating: patch.rating,
        seasonBattles: 0,
        ...(patch.lastSeason ? { lastSeasonJson: JSON.stringify(patch.lastSeason), seasonResultPending: 1 } : {}),
      })
      .where(and(eq(arenaProfiles.userId, userId), eq(arenaProfiles.season, fromSeason)));
    return affectedRows(result) === 1;
  }

  async markSeasonResultSeen(userId: string, session: DbSession): Promise<void> {
    await this.db(session).update(arenaProfiles).set({ seasonResultPending: 0 }).where(eq(arenaProfiles.userId, userId));
  }

  async adoptUntrackedProfiles(season: number): Promise<number> {
    return affectedRows(await this.database.update(arenaProfiles).set({ season }).where(eq(arenaProfiles.season, 0)));
  }

  async listOutdatedSeasonUserIds(currentSeason: number, limit: number): Promise<string[]> {
    const rows = await this.database.select({ userId: arenaProfiles.userId }).from(arenaProfiles)
      .where(and(gt(arenaProfiles.season, 0), ne(arenaProfiles.season, currentSeason)))
      .limit(limit);
    return rows.map((row) => row.userId);
  }

  async rankOf(rating: number, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ better: sql<number>`count(*)` }).from(arenaProfiles).where(gt(arenaProfiles.rating, rating));
    return Number(row?.better ?? 0) + 1;
  }

  async topRatings(limit: number): Promise<ArenaRankingRow[]> {
    return this.database.select({
      userId: arenaProfiles.userId,
      name: userProfile.name,
      level: userProfile.level,
      rating: arenaProfiles.rating,
    }).from(arenaProfiles)
      .innerJoin(userProfile, eq(userProfile.userId, arenaProfiles.userId))
      .orderBy(desc(arenaProfiles.rating), asc(arenaProfiles.updatedAt), asc(arenaProfiles.userId))
      .limit(limit);
  }

  async findCandidates(rating: number, excludeUserIds: string[], limit: number): Promise<ArenaCandidate[]> {
    const conditions = [isNotNull(arenaProfiles.defenseJson)];
    if (excludeUserIds.length > 0) conditions.push(notInArray(arenaProfiles.userId, excludeUserIds));

    const rows = await this.database.select({
      userId: arenaProfiles.userId,
      publicId: arenaProfiles.publicId,
      name: userProfile.name,
      accountLevel: userProfile.level,
      rating: arenaProfiles.rating,
      defenseJson: arenaProfiles.defenseJson,
    }).from(arenaProfiles)
      .innerJoin(userProfile, eq(userProfile.userId, arenaProfiles.userId))
      .where(and(...conditions))
      .orderBy(asc(sql`abs(${arenaProfiles.rating} - ${rating})`), asc(arenaProfiles.userId))
      .limit(limit);

    const candidates: ArenaCandidate[] = [];
    for (const { defenseJson, ...row } of rows) {
      const defense = parseDefense(defenseJson);
      if (defense) candidates.push({ ...row, defense });
    }
    return candidates;
  }

  async recentDefenderIds(attackerId: string, since: Date): Promise<string[]> {
    const rows = await this.database.selectDistinct({ defenderId: arenaBattles.defenderId }).from(arenaBattles)
      .where(and(eq(arenaBattles.attackerId, attackerId), isNotNull(arenaBattles.defenderId), gte(arenaBattles.createdAt, since)));
    return rows.map((row) => row.defenderId).filter((value): value is string => !!value);
  }

  async insertBattle(
    battle: { battleId: string; attackerId: string; defenderId: string | null; npcId: string | null; attackerRatingBefore: number },
    session: DbSession,
  ): Promise<void> {
    await this.db(session).insert(arenaBattles).values(battle);
  }

  async lockBattle(battleId: string, attackerId: string, session: DbSession): Promise<ArenaBattleRecord | null> {
    const [row] = await this.db(session).select({
      battleId: arenaBattles.battleId,
      attackerId: arenaBattles.attackerId,
      defenderId: arenaBattles.defenderId,
      npcId: arenaBattles.npcId,
      attackerRatingBefore: arenaBattles.attackerRatingBefore,
      rewardsGranted: arenaBattles.rewardsGranted,
      result: arenaBattles.resultJson,
    }).from(arenaBattles)
      .where(and(eq(arenaBattles.battleId, battleId), eq(arenaBattles.attackerId, attackerId)))
      .limit(1).for("update");
    return row ? { ...row, rewardsGranted: row.rewardsGranted === 1, result: parseJson(row.result) } : null;
  }

  async finishBattle(
    battleId: string,
    outcome: { won: boolean; attackerRatingBefore: number; ratingDelta: number; defenderDelta: number; result: unknown; at: Date },
    session: DbSession,
  ): Promise<void> {
    await this.db(session).update(arenaBattles)
      .set({
        result: outcome.won ? "win" : "loss",
        attackerRatingBefore: outcome.attackerRatingBefore,
        ratingDelta: outcome.ratingDelta,
        defenderDelta: outcome.defenderDelta,
        rewardsGranted: 1,
        resultJson: outcome.result,
        finishedAt: outcome.at,
      })
      .where(eq(arenaBattles.battleId, battleId));
  }

  async listDefenseLog(defenderId: string, limit: number): Promise<ArenaDefenseLogEntry[]> {
    const rows = await this.database.select({
      attackerName: userProfile.name,
      result: arenaBattles.result,
      defenderDelta: arenaBattles.defenderDelta,
      at: arenaBattles.finishedAt,
    }).from(arenaBattles)
      .innerJoin(userProfile, eq(userProfile.userId, arenaBattles.attackerId))
      .where(and(eq(arenaBattles.defenderId, defenderId), eq(arenaBattles.rewardsGranted, 1)))
      .orderBy(desc(arenaBattles.finishedAt), desc(arenaBattles.battleId))
      .limit(limit);
    return rows.map((row) => ({
      attackerName: row.attackerName,
      defenseWon: row.result === "loss",
      ratingChange: row.defenderDelta,
      at: row.at ?? new Date(0),
    }));
  }
}
