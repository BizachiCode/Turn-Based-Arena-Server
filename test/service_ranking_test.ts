import assert from "node:assert/strict";

import { RankingConfigSchema, parseRankingConfig, type RankingConfig } from "../src/config/RankingCatalog";
import { TowerCatalogSchema, type TowerCatalog } from "../src/config/TowerCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { InMemoryCache, noCache, type KeyValueCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import { assignRanks, effectiveLimit, levelScore, playerMetricOf, type PlayerMetric } from "../src/modules/ranking/ranking.domain";
import type {
  GuildScoreRow,
  GuildStanding,
  RankingProfile,
  RankingRepository,
  RankingScoreRow,
  RankingStanding,
} from "../src/modules/ranking/ranking.ports";
import { RankingService } from "../src/modules/ranking/ranking.service";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0); // Wednesday, week of 2026-10-12
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

type Player = {
  userId: string;
  name: string;
  level: number;
  exp: number;
  rating?: number;
  monsters?: string[];
  /** `regionId|seasonKey` -> floors. */
  floors?: Record<string, number>;
  /** `difficulty|stage` cleared. */
  stages?: Array<{ region: string; difficulty: string }>;
  guildId?: string;
  banned?: boolean;
};

/** In-memory leaderboards (same semantics as the Drizzle repository). */
class InMemoryRankingRepository implements RankingRepository {
  players: Player[] = [];
  guilds: Array<{ id: string; name: string; iconId: string; memberCount: number; points: number; week: string }> = [];
  calls = { topScores: 0, standing: 0, topGuilds: 0 };

  private value(metric: PlayerMetric, player: Player): { value: number; score: number } {
    switch (metric.kind) {
      case "level": return { value: player.level, score: levelScore(player.level, player.exp) };
      case "arena": return player.rating === undefined ? { value: 0, score: -1 } : { value: player.rating, score: player.rating };
      case "collection": {
        const distinct = new Set(player.monsters ?? []).size;
        return { value: distinct, score: distinct };
      }
      case "tower": {
        const total = metric.seasons.reduce((sum, season) => sum + (player.floors?.[`${season.regionId}|${season.seasonKey}`] ?? 0), 0);
        return { value: total, score: total };
      }
      case "story": {
        const names = ["Easy", "Normal", "Hard", "Hell"];
        const total = (player.stages ?? []).filter((stage) => metric.regionIds.includes(stage.region))
          .reduce((sum, stage) => sum + (metric.weights[names.indexOf(stage.difficulty)] ?? 0), 0);
        return { value: total, score: total };
      }
    }
  }

  private ranked(metric: PlayerMetric) {
    return this.players.filter((player) => !player.banned)
      .map((player) => ({ player, ...this.value(metric, player) }))
      .filter((row) => (metric.kind === "level" ? true : metric.kind === "arena" ? row.score >= 0 : row.score > 0))
      .sort((a, b) => b.score - a.score || a.player.userId.localeCompare(b.player.userId));
  }

  async topScores(metric: PlayerMetric, limit: number): Promise<RankingScoreRow[]> {
    this.calls.topScores++;
    return this.ranked(metric).slice(0, limit).map((row) => ({ userId: row.player.userId, value: row.value, score: row.score }));
  }

  async standing(metric: PlayerMetric, userId: string): Promise<RankingStanding | null> {
    this.calls.standing++;
    const rows = this.ranked(metric);
    const mine = this.players.find((player) => player.userId === userId);
    if (!mine) return null;
    const own = this.value(metric, mine);
    if (metric.kind !== "level" && !(own.score > (metric.kind === "arena" ? -1 : 0))) return null;
    return { value: own.value, score: own.score, better: rows.filter((row) => row.score > own.score).length };
  }

  async profiles(userIds: string[]): Promise<Map<string, RankingProfile>> {
    const result = new Map<string, RankingProfile>();
    for (const player of this.players.filter((entry) => userIds.includes(entry.userId))) {
      result.set(player.userId, {
        displayName: player.name,
        iconId: `icon_${player.name}`,
        level: player.level,
        guildTag: this.guilds.find((guild) => guild.id === player.guildId)?.name ?? null,
      });
    }
    return result;
  }

  private guildRows(week: string): GuildScoreRow[] {
    return this.guilds.filter((guild) => guild.week === week && guild.points > 0)
      .map((guild) => ({ guildId: guild.id, name: guild.name, iconId: guild.iconId, memberCount: guild.memberCount, value: guild.points }))
      .sort((a, b) => b.value - a.value || a.guildId.localeCompare(b.guildId));
  }

  async topGuilds(week: string, limit: number): Promise<GuildScoreRow[]> {
    this.calls.topGuilds++;
    return this.guildRows(week).slice(0, limit);
  }

  async guildStanding(userId: string, week: string): Promise<GuildStanding | null> {
    const player = this.players.find((entry) => entry.userId === userId);
    const guild = this.guilds.find((entry) => entry.id === player?.guildId && entry.week === week) ?? this.guilds.find((entry) => entry.id === player?.guildId);
    if (!guild) return null;
    const value = guild.week === week ? guild.points : 0;
    return {
      row: { guildId: guild.id, name: guild.name, iconId: guild.iconId, memberCount: guild.memberCount, value },
      better: this.guildRows(week).filter((row) => row.value > value).length,
    };
  }
}

function setup(options: { config?: Partial<RankingConfig>; towers?: TowerCatalog; cache?: KeyValueCache } = {}) {
  const repo = new InMemoryRankingRepository();
  const clock = new FixedClock(NOW);
  let config = RankingConfigSchema.parse(options.config ?? {});
  let towers = options.towers ?? TowerCatalogSchema.parse({ towers: [{ regionId: "toa", reset: "monthly" }, { regionId: "tod", reset: "weekly" }] });
  const service = new RankingService({
    repo,
    cache: options.cache ?? new InMemoryCache(),
    clock,
    config: () => config,
    towers: () => towers,
    storyRegionIds: () => ["r1", "r2"],
    guildWeek: () => ({ resetHourUtc: 0, weekStartsOn: 1 }),
  });
  return { repo, clock, service, setConfig: (next: unknown) => { config = RankingConfigSchema.parse(next); }, setTowers: (next: TowerCatalog) => { towers = next; } };
}

const player = (userId: string, level: number, extra: Partial<Player> = {}): Player => ({ userId, name: userId.toUpperCase(), level, exp: 0, ...extra });

describe("Ranking domain", () => {
  it("level score orders by level, then exp", () => {
    assert.ok(levelScore(5, 0) > levelScore(4, 999_999_999));
    assert.ok(levelScore(5, 10) > levelScore(5, 9));
  });

  it("equal scores share a rank (competition ranking)", () => {
    const ranks = assignRanks([{ score: 9 }, { score: 7 }, { score: 7 }, { score: 3 }]).map((row) => row.rank);
    assert.deepEqual(ranks, [1, 2, 2, 4]);
  });

  it("limits are clamped to the category size", () => {
    assert.equal(effectiveLimit(undefined, 50, 30), 30);
    assert.equal(effectiveLimit(10, 50, 30), 10);
    assert.equal(effectiveLimit(90, 50, 30), 30);
  });

  it("tower metric sums every tower at its own season, or only the requested one", () => {
    const towers = TowerCatalogSchema.parse({ towers: [{ regionId: "toa", reset: "monthly" }, { regionId: "tod", reset: "weekly" }, { regionId: "toe", reset: "never" }] });
    const context = { now: new Date(NOW), towers, storyRegionIds: [] };
    const all = playerMetricOf({ kind: "tower", regionId: "", difficultyWeights: [1, 2, 3, 4] }, context);
    assert.deepEqual(all, { kind: "tower", seasons: [
      { regionId: "toa", seasonKey: "M:2026-10" },
      { regionId: "tod", seasonKey: "W:2026-10-12" },
      { regionId: "toe", seasonKey: "all" },
    ] });
    const one = playerMetricOf({ kind: "tower", regionId: "tod", difficultyWeights: [1, 2, 3, 4] }, context);
    assert.deepEqual(one, { kind: "tower", seasons: [{ regionId: "tod", seasonKey: "W:2026-10-12" }] });
  });
});

describe("Ranking config", () => {
  it("defaults to the six sample categories", () => {
    const config = RankingConfigSchema.parse({});
    assert.deepEqual(config.categories.map((category) => category.kind), ["level", "arena", "tower", "story", "collection", "guild"]);
    assert.deepEqual(config.categories[3].difficultyWeights, [1, 2, 3, 4]);
    assert.equal(config.defaultTopSize, 50);
  });

  it("accepts PascalCase keys and enum ordinals, rejects duplicate ids", () => {
    const config = parseRankingConfig(JSON.stringify({
      DefaultTopSize: 20,
      Categories: [{ Id: "a", Kind: 2, TopSize: 10, DifficultyWeights: [5] }, { Id: "b", Kind: "Guild" }],
    }));
    assert.equal(config.defaultTopSize, 20);
    assert.equal(config.categories[0].kind, "tower");
    assert.deepEqual(config.categories[0].difficultyWeights, [5, 2, 3, 4]);
    assert.equal(config.categories[1].kind, "guild");
    assert.throws(() => parseRankingConfig(JSON.stringify({ categories: [{ id: "a", kind: 0 }, { id: "a", kind: 1 }] })));
  });
});

describe("RankingService", () => {
  it("lists the enabled categories ordered by `order`", () => {
    const { service } = setup({
      config: { categories: [
        { id: "late", kind: "arena", order: 5 }, { id: "off", kind: "level", enabled: false }, { id: "first", kind: "collection", order: -1 },
      ] } as never,
    });
    const response = service.categories();
    assert.deepEqual(response.categories.map((category) => category.id), ["first", "late"]);
    assert.equal(response.categories[0].subject, "player");
    assert.equal(response.defaultLimit, 50);
  });

  it("answers no categories when rankings are disabled and refuses lists", async () => {
    const { service } = setup({ config: { enabled: false } });
    assert.deepEqual(service.categories().categories, []);
    await assert.rejects(service.list("a", { category: "level" }), isError("RANKING_DISABLED"));
  });

  it("rejects unknown and disabled categories", async () => {
    const { service } = setup({ config: { categories: [{ id: "x", kind: "level", enabled: false }] } as never });
    await assert.rejects(service.list("a", { category: "x" }), isError("RANKING_UNKNOWN_CATEGORY"));
    await assert.rejects(service.list("a", { category: "nope" }), isError("RANKING_UNKNOWN_CATEGORY"));
  });

  it("level: orders by level then exp and flags the caller", async () => {
    const { service, repo } = setup();
    repo.players = [player("a", 10), player("b", 12), { ...player("c", 10), exp: 50 }, player("d", 1, { banned: true })];
    const response = await service.list("a", { category: "level" });
    assert.deepEqual(response.entries.map((entry) => [entry.rank, entry.displayName, entry.value]), [[1, "B", 12], [2, "C", 10], [3, "A", 10]]);
    assert.deepEqual(response.entries.map((entry) => entry.isMe), [false, false, true]);
    assert.equal(response.me?.rank, 3);
    assert.equal(response.me?.inTop, true);
  });

  it("returns the caller's rank even outside the top list", async () => {
    const { service, repo } = setup({ config: { categories: [{ id: "level", kind: "level", topSize: 2 }] } as never });
    repo.players = [player("a", 30), player("b", 20), player("c", 10), player("d", 5)];
    const response = await service.list("d", { category: "level" });
    assert.equal(response.entries.length, 2);
    assert.ok(response.entries.every((entry) => !entry.isMe));
    assert.deepEqual([response.me?.rank, response.me?.value, response.me?.inTop, response.me?.displayName], [4, 5, false, "D"]);
  });

  it("limit defaults to the config and never exceeds the category size", async () => {
    const { service, repo } = setup({ config: { defaultTopSize: 3, categories: [{ id: "level", kind: "level", topSize: 4 }] } as never });
    repo.players = Array.from({ length: 10 }, (_, index) => player(`p${index}`, 10 + index));
    assert.equal((await service.list("p0", { category: "level" })).entries.length, 3);
    assert.equal((await service.list("p0", { category: "level", limit: 2 })).entries.length, 2);
    assert.equal((await service.list("p0", { category: "level", limit: 100 })).entries.length, 4);
  });

  it("ties share the rank in the list and in `me`", async () => {
    const { service, repo } = setup();
    repo.players = [player("a", 1, { rating: 1200 }), player("b", 1, { rating: 1200 }), player("c", 1, { rating: 1000 })];
    const response = await service.list("c", { category: "arena" });
    assert.deepEqual(response.entries.map((entry) => entry.rank), [1, 1, 3]);
    assert.equal(response.me?.rank, 3);
  });

  it("a player without arena profile is unranked (rank 0)", async () => {
    const { service, repo } = setup();
    repo.players = [player("a", 1, { rating: 1200 }), player("b", 1)];
    const response = await service.list("b", { category: "arena" });
    assert.equal(response.entries.length, 1);
    assert.deepEqual([response.me?.rank, response.me?.value, response.me?.inTop], [0, 0, false]);
  });

  it("collection counts distinct monsters", async () => {
    const { service, repo } = setup();
    repo.players = [player("a", 1, { monsters: ["x", "x", "y"] }), player("b", 1, { monsters: ["x", "y", "z"] }), player("c", 1)];
    const response = await service.list("a", { category: "collection" });
    assert.deepEqual(response.entries.map((entry) => [entry.displayName, entry.value]), [["B", 3], ["A", 2]]);
    assert.equal((await service.list("c", { category: "collection" })).me?.rank, 0);
  });

  it("tower adds the floors of the current seasons only", async () => {
    const { service, repo } = setup();
    repo.players = [
      player("a", 1, { floors: { "toa|M:2026-10": 12, "tod|W:2026-10-12": 3 } }),
      player("b", 1, { floors: { "toa|M:2026-09": 99, "toa|M:2026-10": 20 } }),
    ];
    const response = await service.list("a", { category: "tower" });
    assert.deepEqual(response.entries.map((entry) => [entry.displayName, entry.value]), [["B", 20], ["A", 15]]);
  });

  it("tower category with a regionId ranks that tower only", async () => {
    const { service, repo } = setup({ config: { categories: [{ id: "tod", kind: "tower", regionId: "tod" }] } as never });
    repo.players = [player("a", 1, { floors: { "toa|M:2026-10": 12, "tod|W:2026-10-12": 3 } }), player("b", 1, { floors: { "tod|W:2026-10-12": 5 } })];
    const response = await service.list("a", { category: "tod" });
    assert.deepEqual(response.entries.map((entry) => [entry.displayName, entry.value]), [["B", 5], ["A", 3]]);
  });

  it("story weighs harder difficulties more and ignores non-story regions", async () => {
    const { service, repo } = setup();
    repo.players = [
      player("a", 1, { stages: [{ region: "r1", difficulty: "Easy" }, { region: "r1", difficulty: "Normal" }, { region: "r2", difficulty: "Hell" }] }), // 1+2+4
      player("b", 1, { stages: [{ region: "r1", difficulty: "Hard" }, { region: "dungeon", difficulty: "Hell" }] }), // 3
    ];
    const response = await service.list("b", { category: "story" });
    assert.deepEqual(response.entries.map((entry) => [entry.displayName, entry.value]), [["A", 7], ["B", 3]]);
    assert.equal(response.me?.rank, 2);
  });

  it("shows the player's guild name as tag", async () => {
    const { service, repo } = setup();
    repo.guilds = [{ id: "g1", name: "Wolves", iconId: "emblem", memberCount: 4, points: 10, week: "W:2026-10-12" }];
    repo.players = [player("a", 5, { guildId: "g1" }), player("b", 4)];
    const response = await service.list("b", { category: "level" });
    assert.deepEqual(response.entries.map((entry) => entry.guildTag), ["Wolves", null]);
  });

  it("guild category ranks guilds by the points of the current week", async () => {
    const { service, repo } = setup();
    repo.guilds = [
      { id: "g1", name: "Wolves", iconId: "e1", memberCount: 4, points: 300, week: "W:2026-10-12" },
      { id: "g2", name: "Bears", iconId: "e2", memberCount: 9, points: 500, week: "W:2026-10-12" },
      { id: "g3", name: "Old", iconId: "e3", memberCount: 2, points: 9999, week: "W:2026-10-05" },
      { id: "g4", name: "Idle", iconId: "e4", memberCount: 1, points: 0, week: "W:2026-10-12" },
    ];
    repo.players = [player("a", 1, { guildId: "g1" }), player("b", 1), player("c", 1, { guildId: "g3" })];
    const response = await service.list("a", { category: "guild" });
    assert.equal(response.subject, "guild");
    assert.deepEqual(response.entries.map((entry) => [entry.rank, entry.displayName, entry.level, entry.value, entry.isMe]), [
      [1, "Bears", 9, 500, false],
      [2, "Wolves", 4, 300, true],
    ]);
    assert.deepEqual([response.me?.rank, response.me?.displayName, response.me?.inTop], [2, "Wolves", true]);

    assert.equal((await service.list("b", { category: "guild" })).me, null);
    const inactive = await service.list("c", { category: "guild" });
    assert.deepEqual([inactive.me?.displayName, inactive.me?.rank, inactive.me?.value], ["Old", 0, 0]);
  });

  it("the heavy query runs once per refresh interval and is shared by every request", async () => {
    const { service, repo, clock } = setup({ config: { defaultRefreshSeconds: 60 } });
    repo.players = [player("a", 10), player("b", 5)];
    await service.list("a", { category: "level" });
    await service.list("b", { category: "level" });
    await service.list("a", { category: "level", limit: 1 });
    assert.equal(repo.calls.topScores, 1);
    assert.ok(repo.calls.standing >= 3, "the caller's own rank is looked up per request");

    repo.players.push(player("c", 20));
    clock.advance(59_000);
    assert.equal((await service.list("a", { category: "level" })).entries.length, 2, "still the cached list");

    clock.advance(2_000);
    const refreshed = await service.list("a", { category: "level" });
    assert.equal(repo.calls.topScores, 2);
    assert.equal(refreshed.entries.length, 3);
    assert.equal(refreshed.me?.rank, 2);
  });

  it("category refreshSeconds overrides the default", async () => {
    const { service, repo, clock } = setup({ config: { defaultRefreshSeconds: 600, categories: [{ id: "level", kind: "level", refreshSeconds: 10 }] } as never });
    repo.players = [player("a", 10)];
    const first = await service.list("a", { category: "level" });
    assert.equal(first.nextRefreshUnix - first.updatedAtUnix, 10);
    clock.advance(11_000);
    await service.list("a", { category: "level" });
    assert.equal(repo.calls.topScores, 2);
  });

  it("concurrent requests on a cold cache run a single query", async () => {
    const { service, repo } = setup();
    repo.players = [player("a", 10)];
    await Promise.all([1, 2, 3, 4, 5].map(() => service.list("a", { category: "level" })));
    assert.equal(repo.calls.topScores, 1);
  });

  it("works without the shared cache (in-process copy)", async () => {
    const { service, repo } = setup({ cache: noCache });
    repo.players = [player("a", 10)];
    await service.list("a", { category: "level" });
    await service.list("a", { category: "level" });
    assert.equal(repo.calls.topScores, 1);
  });

  it("another server instance reuses the list from the shared cache", async () => {
    const shared = new InMemoryCache();
    const one = setup({ cache: shared });
    const two = setup({ cache: shared });
    one.repo.players = [player("a", 10)];
    two.repo.players = [player("a", 10)];
    await one.service.list("a", { category: "level" });
    await two.service.list("a", { category: "level" });
    assert.equal(one.repo.calls.topScores, 1);
    assert.equal(two.repo.calls.topScores, 0);
  });

  it("a season rollover or a config change invalidates the cached list at once", async () => {
    const { service, repo, clock, setConfig } = setup({ config: { defaultRefreshSeconds: 3600 } });
    repo.players = [player("a", 1, { floors: { "toa|M:2026-10": 4, "toa|M:2026-11": 1 } })];
    assert.equal((await service.list("a", { category: "tower" })).entries[0].value, 4);

    clock.set(Date.UTC(2026, 10, 1, 0, 30)); // new monthly season, well inside the refresh interval
    assert.equal((await service.list("a", { category: "tower" })).entries[0].value, 1);

    setConfig({ defaultRefreshSeconds: 3600, categories: [{ id: "tower", kind: "tower", topSize: 5 }] });
    await service.list("a", { category: "tower" });
    assert.equal(repo.calls.topScores, 3);
  });
});
