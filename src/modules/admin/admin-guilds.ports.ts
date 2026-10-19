// GM panel "Guilds": list and detail read models. Guild changes go through `GuildService.operator*`.

export const GUILD_FILTERS = ["all", "open", "approval"] as const;
export type AdminGuildFilter = typeof GUILD_FILTERS[number];
export const GUILD_SORTS = ["name", "members", "created", "minLevel", "activity"] as const;
export type AdminGuildSort = typeof GUILD_SORTS[number];

export type AdminGuildListQuery = {
  filter: AdminGuildFilter;
  q: string | null;
  sort: AdminGuildSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type AdminGuildRow = {
  guildId: string;
  name: string;
  memberCount: number;
  leaderName: string | null;
  leaderUserId: string | null;
  joinType: "open" | "approval";
  minLevel: number;
  /** Activity points of every week (guild quests). */
  activityPoints: number;
  createdAt: string;
};

export type AdminGuildList = {
  rows: AdminGuildRow[];
  total: number;
  counts: Record<AdminGuildFilter, number>;
};

export type AdminGuildMember = {
  userId: string;
  /** Handle the guild actions (kick / transfer) take. */
  publicId: string;
  name: string | null;
  level: number | null;
  role: "leader" | "officer" | "member";
  joinedAt: string;
  lastLoginAt: string | null;
};

export type AdminGuildDetail = {
  guild: AdminGuildRow & { description: string; notice: string; iconId: string; tags: string[] };
  members: AdminGuildMember[];
  pendingRequests: number;
};

export interface AdminGuildRepository {
  list(query: AdminGuildListQuery): Promise<AdminGuildList>;
  detail(guildId: string): Promise<AdminGuildDetail | null>;
}
