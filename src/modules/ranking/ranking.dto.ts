/** One row of a leaderboard. Players: `level` is the account level. Guilds: `level` is the member count. */
export type RankingEntryDto = {
  rank: number;
  displayName: string;
  iconId: string;
  level: number;
  value: number;
  /** Guild name of the player (players' categories only; null without a guild). */
  guildTag: string | null;
  isMe: boolean;
};

/** The caller's own row; `rank` 0 = not ranked (nothing to rank yet). */
export type RankingMeDto = RankingEntryDto & { inTop: boolean };

export type RankingCategoryDto = {
  id: string;
  kind: string;
  /** `player` or `guild`. */
  subject: string;
  order: number;
  titleKey: string;
  descriptionKey: string;
  valueKey: string;
  iconId: string;
  topSize: number;
  refreshSeconds: number;
};

export type RankingCategoriesResponseDto = {
  ok: true;
  defaultLimit: number;
  categories: RankingCategoryDto[];
};

export type RankingListResponseDto = {
  ok: true;
  category: string;
  subject: string;
  /** When the cached list was computed / when it is recomputed (unix seconds). */
  updatedAtUnix: number;
  nextRefreshUnix: number;
  entries: RankingEntryDto[];
  /** Null for guild categories when the caller has no guild. */
  me: RankingMeDto | null;
};
