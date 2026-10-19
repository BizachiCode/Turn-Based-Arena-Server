import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { GuildJoinType, GuildRole } from "./guild.domain.js";

/** One guild (`guilds`). */
export type GuildRecord = {
  id: string;
  name: string;
  description: string;
  notice: string;
  iconId: string;
  tags: string[];
  joinType: GuildJoinType;
  minLevel: number;
  memberCount: number;
  createdAt: Date;
};

/** Guild row of the list/details views, with the leader's current name. */
export type GuildListRow = GuildRecord & { leaderName: string };

/** One membership (`guild_members`). */
export type GuildMemberRecord = {
  userId: string;
  guildId: string;
  publicId: string;
  role: GuildRole;
  joinedAt: Date;
};

/** Membership joined with the player's profile and activity (member list). */
export type GuildMemberProfile = GuildMemberRecord & {
  name: string;
  level: number;
  iconId: string;
  /** Last presence heartbeat or login (null when never seen). */
  lastActiveAt: Date | null;
  online: boolean;
};

/** One join request (`guild_join_requests`). */
export type GuildRequestRecord = { id: string; guildId: string; userId: string; createdAt: Date };

/** Pending request with the applicant's profile (officers' list). */
export type GuildApplicantRow = { id: string; name: string; level: number; iconId: string; createdAt: Date };

/** Pending request of the player with the target guild summary. */
export type GuildOwnRequestRow = { guildId: string; name: string; iconId: string; memberCount: number; createdAt: Date };

export type PlayerProfileRow = { name: string; level: number; iconId: string };

export type GuildPatch = Partial<Pick<GuildRecord, "description" | "notice" | "iconId" | "tags" | "joinType" | "minLevel">>;

/**
 * Persistence port of the guilds. Membership changes of a guild run under its row lock (`findGuild(..., true)`);
 * `guild_members.user_id` is the primary key, so a second membership fails with a duplicate-key error.
 */
export interface GuildRepository {
  findMembership(userId: string, session?: DbSession, forUpdate?: boolean): Promise<GuildMemberRecord | null>;
  /** Member of `guildId` with this public id (null when not in that guild). */
  findMemberByPublicId(guildId: string, publicId: string, session: DbSession): Promise<GuildMemberRecord | null>;
  listMembers(guildId: string, session?: DbSession, forUpdate?: boolean): Promise<GuildMemberRecord[]>;
  /** Members with profile and activity; `onlineSince` = oldest heartbeat that still counts as online. */
  listMemberProfiles(guildId: string, onlineSince: Date): Promise<GuildMemberProfile[]>;
  insertMember(member: Omit<GuildMemberRecord, "joinedAt">, session: DbSession): Promise<void>;
  deleteMember(userId: string, session: DbSession): Promise<void>;
  setRole(userId: string, role: GuildRole, session: DbSession): Promise<void>;

  findGuild(guildId: string, session?: DbSession, forUpdate?: boolean): Promise<GuildRecord | null>;
  findGuildRow(guildId: string): Promise<GuildListRow | null>;
  isNameTaken(nameKey: string, session?: DbSession): Promise<boolean>;
  /** Throws a duplicate-key error when the name key is taken. */
  insertGuild(guild: Omit<GuildRecord, "createdAt" | "memberCount"> & { nameKey: string; memberCount: number }, session: DbSession): Promise<void>;
  updateGuild(guildId: string, patch: GuildPatch, session: DbSession): Promise<void>;
  /** Changes the name and its uniqueness key (GM rename); throws a duplicate-key error when the key is taken. */
  renameGuild(guildId: string, name: string, nameKey: string, session: DbSession): Promise<void>;
  addMemberCount(guildId: string, delta: number, session: DbSession): Promise<void>;
  deleteGuild(guildId: string, session: DbSession): Promise<void>;
  /**
   * Name search (`search`, case-insensitive substring) or recommendations: guilds with room first, then those whose
   * level requirement the player meets, open ones, the most members and the newest.
   */
  listGuilds(filter: { search: string | null; playerLevel: number; maxMembers: number; limit: number }): Promise<GuildListRow[]>;

  findRequest(requestId: string, session: DbSession, forUpdate?: boolean): Promise<GuildRequestRecord | null>;
  findRequestFor(guildId: string, userId: string, session?: DbSession): Promise<GuildRequestRecord | null>;
  insertRequest(request: Omit<GuildRequestRecord, "createdAt">, session: DbSession): Promise<void>;
  deleteRequest(requestId: string, session: DbSession): Promise<void>;
  deleteRequestsOfUser(userId: string, session: DbSession): Promise<void>;
  /** Drops the player's requests created before `before` (expired). */
  deleteExpiredRequestsOfUser(userId: string, before: Date, session: DbSession): Promise<void>;
  countRequestsOfUser(userId: string, since: Date, session?: DbSession): Promise<number>;
  listRequestsOfUser(userId: string, since: Date): Promise<GuildOwnRequestRow[]>;
  listRequestsOfGuild(guildId: string, since: Date): Promise<GuildApplicantRow[]>;
  countRequestsOfGuild(guildId: string, since: Date): Promise<number>;

  profileOf(userId: string, session?: DbSession): Promise<PlayerProfileRow | null>;
}
