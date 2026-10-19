// Leaderboards: level, arena, towers, story, monster collection and guilds. The top list of each category is the heavy
// part (aggregates over whole tables): it is computed at most once per `refreshSeconds` (in-process copy + the shared
// cache) and reused by every request; the caller's own standing is a bounded lookup computed on demand.

import type { RankingCategoryConfig, RankingConfig } from "../../config/RankingCatalog.js";
import type { TowerCatalog } from "../../config/TowerCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { KeyValueCache } from "../../shared/kernel/cache.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { assignRanks, effectiveLimit, guildWeekOf, playerMetricOf, subjectOf, type PlayerMetric } from "./ranking.domain.js";
import type {
  RankingCategoriesResponseDto,
  RankingCategoryDto,
  RankingEntryDto,
  RankingListResponseDto,
  RankingMeDto,
} from "./ranking.dto.js";
import type { RankingProfile, RankingRepository } from "./ranking.ports.js";

export type RankingServiceDeps = {
  repo: RankingRepository;
  /** Shared cache (Redis); the service also keeps an in-process copy, so a cache outage never means a query per request. */
  cache: KeyValueCache;
  clock: Clock;
  config: () => RankingConfig;
  towers: () => TowerCatalog;
  /** Ids of the campaign regions (dungeons and towers excluded). */
  storyRegionIds: () => string[];
  /** Reset hour / first weekday of the guild week (same as the guild quests). */
  guildWeek: () => { resetHourUtc: number; weekStartsOn: number };
};

/** One cached row; `ownerId` (user or guild id) stays server side and is only used to flag the caller's row. */
type CachedEntry = Omit<RankingEntryDto, "isMe"> & { ownerId: string };

type Snapshot = {
  /** Metric + size the list was computed for: a config change or a season / week rollover invalidates it. */
  signature: string;
  generatedAtMs: number;
  expiresAtMs: number;
  entries: CachedEntry[];
};

const CACHE_PREFIX = "ranking:top:";

export class RankingService {
  private readonly memory = new Map<string, Snapshot>();
  private readonly inFlight = new Map<string, Promise<Snapshot>>();

  constructor(private readonly deps: RankingServiceDeps) {}

  /** Enabled categories in display order. */
  categories(): RankingCategoriesResponseDto {
    const config = this.deps.config();
    return {
      ok: true,
      defaultLimit: config.defaultTopSize,
      categories: this.enabledCategories().map((category) => this.toCategoryDto(category, config)),
    };
  }

  async list(userId: string, request: { category: string; limit?: number }): Promise<RankingListResponseDto> {
    const config = this.deps.config();
    const category = this.findCategory(request.category);
    const size = this.topSizeOf(category, config);
    const limit = effectiveLimit(request.limit, config.defaultTopSize, size);
    const snapshot = await this.snapshotOf(category, size, config);
    const me = await this.standingOf(userId, category, snapshot);
    const ownerId = me?.ownerId ?? null;

    return {
      ok: true,
      category: category.id,
      subject: subjectOf(category.kind),
      updatedAtUnix: Math.floor(snapshot.generatedAtMs / 1000),
      nextRefreshUnix: Math.floor(snapshot.expiresAtMs / 1000),
      entries: snapshot.entries.slice(0, limit).map(({ ownerId: entryOwner, ...entry }) => ({ ...entry, isMe: entryOwner === ownerId })),
      me: me ? me.dto : null,
    };
  }

  // ── Categories ──────────────────────────────────────────────────────

  private enabledCategories(): RankingCategoryConfig[] {
    const config = this.deps.config();
    if (!config.enabled) return [];
    return config.categories
      .filter((category) => category.enabled)
      .map((category, index) => ({ category, index }))
      .sort((a, b) => a.category.order - b.category.order || a.index - b.index)
      .map(({ category }) => category);
  }

  private findCategory(id: string): RankingCategoryConfig {
    if (!this.deps.config().enabled) throw new AppError(ErrorCode.RANKING_DISABLED);
    const category = this.enabledCategories().find((entry) => entry.id === id);
    if (!category) throw new AppError(ErrorCode.RANKING_UNKNOWN_CATEGORY);
    return category;
  }

  private topSizeOf(category: RankingCategoryConfig, config: RankingConfig): number {
    return category.topSize > 0 ? category.topSize : config.defaultTopSize;
  }

  private refreshSecondsOf(category: RankingCategoryConfig, config: RankingConfig): number {
    return category.refreshSeconds > 0 ? category.refreshSeconds : config.defaultRefreshSeconds;
  }

  private toCategoryDto(category: RankingCategoryConfig, config: RankingConfig): RankingCategoryDto {
    return {
      id: category.id,
      kind: category.kind,
      subject: subjectOf(category.kind),
      order: category.order,
      titleKey: category.titleKey,
      descriptionKey: category.descriptionKey,
      valueKey: category.valueKey,
      iconId: category.iconId,
      topSize: this.topSizeOf(category, config),
      refreshSeconds: this.refreshSecondsOf(category, config),
    };
  }

  private metricOf(category: RankingCategoryConfig, now: Date): PlayerMetric | null {
    return playerMetricOf(category, { now, towers: this.deps.towers(), storyRegionIds: this.deps.storyRegionIds() });
  }

  // ── Cached top lists ────────────────────────────────────────────────

  private async snapshotOf(category: RankingCategoryConfig, size: number, config: RankingConfig): Promise<Snapshot> {
    const now = this.deps.clock.now();
    const guild = subjectOf(category.kind) === "guild";
    const metric = guild ? null : this.metricOf(category, now);
    const week = guild ? guildWeekOf(now, this.deps.guildWeek()) : null;
    const signature = JSON.stringify([category.kind, size, metric, week]);
    const key = `${CACHE_PREFIX}${category.id}`;

    const usable = (snapshot: Snapshot | null | undefined): snapshot is Snapshot =>
      !!snapshot && snapshot.signature === signature && snapshot.expiresAtMs > now.getTime();

    const local = this.memory.get(key);
    if (usable(local)) return local;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const load = (async () => {
      const shared = await this.deps.cache.get<Snapshot>(key);
      if (usable(shared)) {
        this.memory.set(key, shared);
        return shared;
      }

      const entries = guild
        ? await this.computeGuilds(week!, size)
        : await this.computePlayers(metric!, size);
      const snapshot: Snapshot = {
        signature,
        generatedAtMs: now.getTime(),
        expiresAtMs: now.getTime() + this.refreshSecondsOf(category, config) * 1000,
        entries,
      };
      this.memory.set(key, snapshot);
      await this.deps.cache.set(key, snapshot, this.refreshSecondsOf(category, config));
      return snapshot;
    })();

    this.inFlight.set(key, load);
    try {
      return await load;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async computePlayers(metric: PlayerMetric, size: number): Promise<CachedEntry[]> {
    const { repo } = this.deps;
    const scores = await repo.topScores(metric, size);
    const profiles = await repo.profiles(scores.map((row) => row.userId));
    const entries: Array<{ score: number; ownerId: string; profile: RankingProfile; value: number }> = [];
    for (const row of scores) {
      const profile = profiles.get(row.userId);
      if (profile) entries.push({ score: row.score, ownerId: row.userId, profile, value: row.value });
    }
    return assignRanks(entries).map((entry) => ({
      ownerId: entry.ownerId,
      rank: entry.rank,
      displayName: entry.profile.displayName,
      iconId: entry.profile.iconId,
      level: entry.profile.level,
      value: entry.value,
      guildTag: entry.profile.guildTag,
    }));
  }

  private async computeGuilds(week: string, size: number): Promise<CachedEntry[]> {
    const rows = await this.deps.repo.topGuilds(week, size);
    return assignRanks(rows.map((row) => ({ ...row, score: row.value }))).map((row) => ({
      ownerId: row.guildId,
      rank: row.rank,
      displayName: row.name,
      iconId: row.iconId,
      level: row.memberCount,
      value: row.value,
      guildTag: null as string | null,
    }));
  }

  // ── The caller's own row ────────────────────────────────────────────

  private async standingOf(
    userId: string,
    category: RankingCategoryConfig,
    snapshot: Snapshot,
  ): Promise<{ ownerId: string; dto: RankingMeDto } | null> {
    const { repo } = this.deps;
    const now = this.deps.clock.now();

    if (subjectOf(category.kind) === "guild") {
      const standing = await repo.guildStanding(userId, guildWeekOf(now, this.deps.guildWeek()));
      if (!standing) return null;
      const { row } = standing;
      const rank = row.value > 0 ? standing.better + 1 : 0;
      return {
        ownerId: row.guildId,
        dto: {
          rank, displayName: row.name, iconId: row.iconId, level: row.memberCount, value: row.value,
          guildTag: null as string | null, isMe: true, inTop: rank > 0 && snapshot.entries.some((entry) => entry.ownerId === row.guildId),
        },
      };
    }

    const metric = this.metricOf(category, now)!;
    const standing = await repo.standing(metric, userId);
    const profile = (await repo.profiles([userId])).get(userId) ?? { displayName: "", iconId: "", level: 1, guildTag: null };
    const rank = standing ? standing.better + 1 : 0;
    return {
      ownerId: userId,
      dto: {
        rank,
        displayName: profile.displayName,
        iconId: profile.iconId,
        level: profile.level,
        value: standing ? standing.value : metric.kind === "level" ? profile.level : 0,
        guildTag: profile.guildTag,
        isMe: true,
        inTop: rank > 0 && snapshot.entries.some((entry) => entry.ownerId === userId),
      },
    };
  }
}
