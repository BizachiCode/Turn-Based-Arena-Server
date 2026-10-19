// GM panel "Players": what an operator sees about one account and the persistence it needs. Read models only expose
// what the panel shows; every write goes through `AdminPlayersService` (audited, transactional where it spends).

import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type AdminPlayerAccount = {
  userId: string;
  username: string;
  email: string | null;
  isGuest: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Failed password attempts and the temporary lock they caused (anti brute force, not a GM ban). */
  failedLogins: number;
  lockedUntil: string | null;
  ban: { active: boolean; reason: string | null; until: string | null } | null;
  chatMute: { active: boolean; reason: string | null; until: string } | null;
  deletionScheduledAt: string | null;
};

export type AdminPlayerProfile = { name: string; iconId: string; level: number; currentExp: number };

export type AdminPlayerUnit = {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  awakeningIndex: number;
  location: "BAG" | "STORAGE";
  locked: boolean;
  /** Runes equipped on the unit. */
  runes: number;
  createdAt: string;
};

export type AdminPlayerRune = {
  uid: string;
  setId: string;
  slot: number;
  tier: number;
  quality: number;
  level: number;
  mainStatType: string;
  mainStatValue: number;
  equippedToUid: string | null;
};

export type AdminPlayerDetail = {
  account: AdminPlayerAccount;
  profile: AdminPlayerProfile | null;
  /** Live balances (regenerating currencies included). */
  wallet: Record<string, number>;
  roster: { bagCapacity: number; storageCapacity: number; units: AdminPlayerUnit[] };
  runes: { capacity: number; total: number; items: AdminPlayerRune[] };
  stages: Array<{ regionId: string; difficulty: string; cleared: number; clears: number }>;
  towers: Array<{ regionId: string; seasonKey: string; clearedFloors: number }>;
  story: {
    completed: Array<{ dialogueId: string; skipped: boolean; times: number; completedAt: string }>;
    active: { dialogueId: string; step: number } | null;
  };
  guild: { guildId: string; name: string; role: string; joinedAt: string } | null;
  arena: { rating: number; wins: number; losses: number; defenseWins: number; defenseLosses: number; season: number; seasonBattles: number } | null;
  /** Presence connections never closed (devices, rooms, last heartbeat); rows left by a crash or restart stay here. */
  connections: Array<{ deviceId: string; room: string; connectedAt: string; lastHeartbeatAt: string; ip: string | null; userAgent: string | null }>;
  /** A connection had a heartbeat within the online window (same rule as the players list). */
  online: boolean;
};

export type AdminAuditEntry = { id: number; kind: string; meta: unknown; createdAt: string };

/** Tabs of the Players list. */
export const PLAYER_FILTERS = ["all", "online", "banned", "muted", "guests", "deletion", "reported"] as const;
export type AdminPlayerFilter = typeof PLAYER_FILTERS[number];
export const PLAYER_SORTS = ["name", "level", "lastLogin", "created"] as const;
export type AdminPlayerSort = typeof PLAYER_SORTS[number];

export type AdminPlayerListQuery = {
  filter: AdminPlayerFilter;
  /** Substring of the account name, profile name, email or id. */
  q: string | null;
  sort: AdminPlayerSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
  /** Heartbeats newer than this count as online. */
  onlineSince: Date;
  now: Date;
};

export type AdminPlayerRow = {
  userId: string;
  username: string;
  /** Profile name (null before the first profile exists). */
  name: string | null;
  email: string | null;
  level: number | null;
  guild: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  online: boolean;
  banned: boolean;
  muted: boolean;
  isGuest: boolean;
  deletionScheduledAt: string | null;
};

export type AdminPlayerList = {
  rows: AdminPlayerRow[];
  /** Rows matching the filter and search (before paging). */
  total: number;
  /** Accounts per tab (search ignored). */
  counts: Record<AdminPlayerFilter, number>;
};

/** Read models and GM-only writes of the Players view. */
export interface AdminPlayerRepository {
  /** Everything but the wallet (the ledger computes live balances); null when the account does not exist. */
  loadDetail(userId: string): Promise<Omit<AdminPlayerDetail, "wallet" | "online"> | null>;
  /** Newest first; `beforeId` pages back. */
  auditTrail(userId: string, limit: number, beforeId?: number): Promise<AdminAuditEntry[]>;
  setChatMute(userId: string, until: Date | null, reason: string | null): Promise<void>;
  /** End of the GM chat mute (null when not muted). */
  chatMutedUntil(userId: string): Promise<Date | null>;
  /** One page of accounts for the Players list, with the tab counters. */
  listPlayers(query: AdminPlayerListQuery): Promise<AdminPlayerList>;
  /** Forgets completed sequences (all when `dialogueIds` is null) and the one in progress; returns the rows removed. */
  resetStory(userId: string, dialogueIds: string[] | null, session: DbSession): Promise<number>;
}
