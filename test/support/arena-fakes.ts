// In-memory arena persistence (same semantics as the Drizzle repository), used by the arena service tests.

import type { ArenaDefense, ArenaOpponentView } from "../../src/modules/arena/arena.domain";
import type {
  ArenaBattleRecord,
  ArenaCandidate,
  ArenaDefenseLogEntry,
  ArenaProfilePatch,
  ArenaProfileRecord,
  ArenaRankingRow,
  ArenaRepository,
  ArenaSeasonPatch,
} from "../../src/modules/arena/arena.ports";

export type StoredArenaProfile = ArenaProfileRecord & { name: string; level: number };

type StoredBattle = ArenaBattleRecord & {
  result_: "win" | "loss" | null;
  attackerDelta: number;
  defenderDelta: number;
  finishedAt: Date | null;
  createdAt: Date;
};

export class InMemoryArenaRepository implements ArenaRepository {
  profiles = new Map<string, StoredArenaProfile>();
  battles = new Map<string, StoredBattle>();
  private seq = 0;

  /** `battleCreatedAtMs`: `created_at` given to new battle rows. */
  constructor(private readonly battleCreatedAtMs: number) {}

  seed(userId: string, extra: Partial<StoredArenaProfile> = {}): StoredArenaProfile {
    const profile: StoredArenaProfile = {
      userId, publicId: `pub${userId}`, rating: 1000, wins: 0, losses: 0, defenseWins: 0, defenseLosses: 0,
      defense: null, opponents: null, opponentsRefreshedAt: null, season: 0, seasonBattles: 0, lastSeason: null,
      seasonResultPending: false, name: `Name-${userId}`, level: 5, ...extra,
    };
    this.profiles.set(userId, profile);
    return profile;
  }

  async ensureProfile(userId: string, startRating: number): Promise<ArenaProfileRecord> {
    return structuredClone(this.profiles.get(userId) ?? this.seed(userId, { rating: startRating, publicId: `pub${++this.seq}${userId}` }));
  }
  async findProfileByPublicId(publicId: string) {
    const found = [...this.profiles.values()].find((profile) => profile.publicId === publicId);
    return found ? structuredClone(found) : null;
  }
  async lockProfiles(userIds: string[]) {
    return new Map(userIds.filter((id) => this.profiles.has(id)).map((id) => [id, structuredClone(this.profiles.get(id)!)]));
  }
  async saveDefense(userId: string, defense: ArenaDefense) { this.profiles.get(userId)!.defense = defense; }
  async findDefense(userId: string) { return this.profiles.get(userId)?.defense ?? null; }
  async saveOpponents(userId: string, opponents: ArenaOpponentView[] | null, refreshedAt: Date | undefined) {
    const profile = this.profiles.get(userId)!;
    profile.opponents = opponents;
    if (refreshedAt) profile.opponentsRefreshedAt = refreshedAt;
  }
  async applyBattleResult(userId: string, patch: ArenaProfilePatch) {
    const profile = this.profiles.get(userId)!;
    profile.rating = patch.rating;
    profile.wins += patch.winsDelta ?? 0;
    profile.losses += patch.lossesDelta ?? 0;
    profile.defenseWins += patch.defenseWinsDelta ?? 0;
    profile.defenseLosses += patch.defenseLossesDelta ?? 0;
    profile.seasonBattles += patch.seasonBattlesDelta ?? 0;
  }
  async rankOf(rating: number) { return 1 + [...this.profiles.values()].filter((profile) => profile.rating > rating).length; }
  async topRatings(limit: number): Promise<ArenaRankingRow[]> {
    return [...this.profiles.values()].sort((a, b) => b.rating - a.rating).slice(0, limit).map((p) => ({ userId: p.userId, name: p.name, level: p.level, rating: p.rating }));
  }
  async findCandidates(rating: number, excludeUserIds: string[], limit: number): Promise<ArenaCandidate[]> {
    return [...this.profiles.values()]
      .filter((p) => p.defense && !excludeUserIds.includes(p.userId))
      .sort((a, b) => Math.abs(a.rating - rating) - Math.abs(b.rating - rating))
      .slice(0, limit)
      .map((p) => ({ userId: p.userId, publicId: p.publicId, name: p.name, accountLevel: p.level, rating: p.rating, defense: p.defense! }));
  }
  async recentDefenderIds(attackerId: string, since: Date) {
    return [...this.battles.values()].filter((b) => b.attackerId === attackerId && b.defenderId && b.createdAt >= since).map((b) => b.defenderId!);
  }
  async insertBattle(battle: { battleId: string; attackerId: string; defenderId: string | null; npcId: string | null; attackerRatingBefore: number }) {
    this.battles.set(battle.battleId, {
      ...battle, rewardsGranted: false, result: null, result_: null, attackerDelta: 0, defenderDelta: 0, finishedAt: null,
      createdAt: new Date(this.battleCreatedAtMs),
    });
  }
  async lockBattle(battleId: string, attackerId: string) {
    const battle = this.battles.get(battleId);
    return battle && battle.attackerId === attackerId ? { ...battle } : null;
  }
  async finishBattle(battleId: string, outcome: { won: boolean; attackerRatingBefore: number; ratingDelta: number; defenderDelta: number; result: unknown; at: Date }) {
    Object.assign(this.battles.get(battleId)!, {
      result_: outcome.won ? "win" : "loss", attackerRatingBefore: outcome.attackerRatingBefore, attackerDelta: outcome.ratingDelta,
      defenderDelta: outcome.defenderDelta, rewardsGranted: true, result: outcome.result, finishedAt: outcome.at,
    });
  }
  async listDefenseLog(defenderId: string, limit: number): Promise<ArenaDefenseLogEntry[]> {
    return [...this.battles.values()].filter((b) => b.defenderId === defenderId && b.rewardsGranted).slice(0, limit).map((b) => ({
      attackerName: this.profiles.get(b.attackerId)!.name, defenseWon: b.result_ === "loss", ratingChange: b.defenderDelta, at: b.finishedAt!,
    }));
  }

  // Seasons: the rollover is a compare-and-set on the stored season, like the conditional UPDATE.
  async rolloverSeason(userId: string, fromSeason: number, patch: ArenaSeasonPatch) {
    const profile = this.profiles.get(userId);
    if (!profile || profile.season !== fromSeason) return false;
    profile.season = patch.season;
    profile.rating = patch.rating;
    profile.seasonBattles = 0;
    if (patch.lastSeason) {
      profile.lastSeason = structuredClone(patch.lastSeason);
      profile.seasonResultPending = true;
    }
    return true;
  }
  async markSeasonResultSeen(userId: string) {
    const profile = this.profiles.get(userId);
    if (profile) profile.seasonResultPending = false;
  }
  async adoptUntrackedProfiles(season: number) {
    let adopted = 0;
    for (const profile of this.profiles.values()) {
      if (profile.season !== 0) continue;
      profile.season = season;
      adopted += 1;
    }
    return adopted;
  }
  async listOutdatedSeasonUserIds(currentSeason: number, limit: number) {
    return [...this.profiles.values()].filter((p) => p.season > 0 && p.season !== currentSeason).slice(0, limit).map((p) => p.userId);
  }

  snapshot(): unknown {
    return {
      profiles: new Map([...this.profiles].map(([id, p]) => [id, structuredClone(p)])),
      battles: new Map([...this.battles].map(([id, b]) => [id, structuredClone(b)])),
    };
  }
  restore(state: unknown): void {
    const saved = state as { profiles: Map<string, StoredArenaProfile>; battles: Map<string, StoredBattle> };
    this.profiles = saved.profiles;
    this.battles = saved.battles;
  }
}
