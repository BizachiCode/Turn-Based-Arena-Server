// Wire shapes of the `guild` room (docs/PROTOCOL.md `guild`; Unity `GuildDTOs.cs`).

import type { GuildQuestKind } from "../../config/GuildCatalog.js";
import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";
import type { GuildJoinType, GuildRole } from "./guild.domain.js";

/** Public guild summary (list, details, own guild). Dates are ISO UTC. */
export type GuildViewDto = {
  guildId: string;
  name: string;
  description: string;
  iconId: string;
  tags: string[];
  joinType: GuildJoinType;
  minLevel: number;
  memberCount: number;
  maxMembers: number;
  leaderName: string;
  createdAt: string;
  /** Members-only announcement (own guild only). */
  notice?: string;
};

export type GuildMemberDto = {
  /** Public handle used by kick/setRole/transfer. */
  memberId: string;
  name: string;
  level: number;
  iconId: string;
  role: GuildRole;
  joinedAt: string;
  lastActiveAt: string | null;
  online: boolean;
  self: boolean;
};

export type GuildOwnRequestDto = {
  guildId: string;
  name: string;
  iconId: string;
  memberCount: number;
  maxMembers: number;
  createdAt: string;
  expiresAt: string;
};

/** `guild/state` and the response of every membership/settings mutation. */
export type GuildStateDto = {
  ok: true;
  serverTime: string;
  guild: GuildViewDto | null;
  role: GuildRole | null;
  members: GuildMemberDto[];
  /** Pending requests of the guild (leader/officers only, else 0). */
  requestCount: number;
  /** The player's pending applications (only without a guild). */
  myRequests: GuildOwnRequestDto[];
};

/** One daily quest of the player (`guild/quests`). `rewards` uses the shop payload shape. */
export type GuildQuestDto = {
  questId: string;
  kind: GuildQuestKind;
  target: number;
  progress: number;
  claimed: boolean;
  /** Points added to the guild week when claimed. */
  guildPoints: number;
  rewards: ShopPackPayload;
};

/** One weekly chest. */
export type GuildChestDto = {
  chestId: string;
  /** Guild week points needed. */
  points: number;
  rewards: ShopPackPayload;
  unlocked: boolean;
  claimed: boolean;
};

export type GuildContributorDto = { name: string; level: number; iconId: string; points: number; self: boolean };

/** `guild/quests` and the response of `guild/claimQuest` / `guild/claimChest` (those add `grants` + `wallet`). */
export type GuildQuestStateDto = {
  ok: true;
  serverTime: string;
  dayKey: string;
  weekKey: string;
  dailyResetAt: string;
  weeklyResetAt: string;
  quests: GuildQuestDto[];
  /** Guild total this week. */
  guildPoints: number;
  /** The player's contribution this week. */
  myPoints: number;
  chests: GuildChestDto[];
  /** Top contributors of the week. */
  contributors: GuildContributorDto[];
};

export type GuildQuestClaimDto = GuildQuestStateDto & { grants: ShopGrantsDto; wallet: WalletSnapshot };
