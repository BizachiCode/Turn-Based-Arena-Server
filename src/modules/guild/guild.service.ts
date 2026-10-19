// Guild use cases: state, list/search, details, creation (paid), join/apply, requests, roles, kick, settings, leave.
// Players affected by someone else's decision (accepted, declined, kicked, promoted, new leader) get a guild notice in
// their mailbox, committed with the change.
//
// Locking: every membership change of a guild runs under its row lock (`findGuild(id, session, true)`), taken as the
// first statement of the transaction so later plain reads see the latest commits. `guild_members.user_id` is the
// primary key, so two concurrent joins of the same player fail with a duplicate key instead of a double membership.

import { randomBytes, randomUUID } from "node:crypto";

import type { GuildConfig } from "../../config/GuildCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { TextGuard } from "../../shared/kernel/text-guard.js";
import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { MailDraft } from "../mail/mail.service.js";
import {
  canKick,
  canManage,
  GUILD_LIST_SIZE,
  normalizeGuildName,
  pickSuccessor,
  sanitizeGuildText,
  type GuildJoinType,
} from "./guild.domain.js";
import type { GuildMemberDto, GuildStateDto, GuildViewDto } from "./guild.dto.js";
import type { GuildListRow, GuildMemberProfile, GuildPatch, GuildRecord, GuildRepository } from "./guild.ports.js";

/** A presence heartbeat newer than this counts as online (same window as the presence room). */
const ONLINE_WINDOW_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Mailbox used for guild notices (implemented by `MailService`). */
export interface GuildNoticeMailer {
  sendInSession(session: DbSession, userId: string, draft: MailDraft): Promise<boolean>;
  notify(userIds: string[]): Promise<void>;
}

/** Guild notices (translation keys `text_mail_guild_<notice>_title|body`, `{0}` = guild name). */
export const GUILD_NOTICES = {
  accepted: { title: "Request accepted", body: "Your request to join {0} was accepted. Welcome to the guild!" },
  rejected: { title: "Request declined", body: "Your request to join {0} was declined." },
  kicked: { title: "Removed from guild", body: "You were removed from {0}." },
  promoted: { title: "Promoted to officer", body: "You are now an officer of {0}." },
  demoted: { title: "Officer role removed", body: "You are no longer an officer of {0}." },
  leader: { title: "New guild leader", body: "You are now the leader of {0}." },
} as const;
export type GuildNotice = keyof typeof GUILD_NOTICES;

/** Membership/role changes published after their commit (the guild chat posts a system line for each). */
export type GuildEventKind = "created" | "joined" | "left" | "kicked" | "promoted" | "demoted" | "leader";

export type GuildEvent = {
  kind: GuildEventKind;
  guildId: string;
  /** The player the event is about. */
  userId: string;
  /** The guild was deleted with this event (a leader leaving alone, a GM disband / removal of the last member). */
  disbanded?: boolean;
};

/** Receives {@link GuildEvent}s after the commit (implemented by `GuildChatService`). Failures never undo the change. */
export interface GuildEventSink {
  guildChanged(event: GuildEvent): Promise<void>;
}

export type GuildServiceDeps = {
  guilds: GuildRepository;
  ledger: WalletLedger;
  uow: UnitOfWork;
  clock: Clock;
  config: () => GuildConfig;
  /** Optional mailbox for the guild notices. */
  mail?: GuildNoticeMailer | null;
  /** Optional listener of membership/role changes (guild chat system lines and access updates). */
  events?: GuildEventSink | null;
  /** Chat word filter (block mode): refuses player-written names, descriptions and notices (operator edits skip it). */
  textGuard?: TextGuard | null;
  /** Id factories (tests inject deterministic ones). */
  newGuildId?: () => string;
  newPublicId?: () => string;
};

export type GuildSettingsInput = {
  description?: string;
  notice?: string;
  iconId?: string;
  tags?: string[];
  joinType?: GuildJoinType;
  minLevel?: number;
};

export type GuildCreateInput = {
  name: string;
  description: string;
  iconId: string;
  tags: string[];
  joinType: GuildJoinType;
  minLevel: number;
};

const logger = createLogger("GuildService");
const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
const randomHex = () => randomBytes(8).toString("hex");

export class GuildService {
  private readonly newGuildId: () => string;
  private readonly newPublicId: () => string;

  constructor(private readonly deps: GuildServiceDeps) {
    this.newGuildId = deps.newGuildId ?? randomUUID;
    this.newPublicId = deps.newPublicId ?? randomHex;
  }

  private get repo(): GuildRepository {
    return this.deps.guilds;
  }

  private get cfg(): GuildConfig {
    return this.deps.config();
  }

  /** Oldest creation date of a join request that has not expired yet. */
  private requestCutoff(): Date {
    return new Date(this.deps.clock.nowMs() - this.cfg.requestExpirationHours * HOUR_MS);
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /** The player's guild (with notice and members) or, without a guild, the player's pending requests. */
  async getState(userId: string): Promise<GuildStateDto> {
    const membership = await this.repo.findMembership(userId);
    const row = membership ? await this.repo.findGuildRow(membership.guildId) : null;
    const base = { ok: true as const, serverTime: this.deps.clock.now().toISOString() };

    if (!membership || !row) {
      const requests = await this.repo.listRequestsOfUser(userId, this.requestCutoff());
      return {
        ...base,
        guild: null,
        role: null,
        members: [],
        requestCount: 0,
        myRequests: requests.map((request) => ({
          guildId: request.guildId,
          name: request.name,
          iconId: request.iconId,
          memberCount: request.memberCount,
          maxMembers: this.cfg.maxMembers,
          createdAt: request.createdAt.toISOString(),
          expiresAt: this.expiryOf(request.createdAt),
        })),
      };
    }

    const members = await this.repo.listMemberProfiles(row.id, new Date(this.deps.clock.nowMs() - ONLINE_WINDOW_MS));
    return {
      ...base,
      guild: { ...this.guildView(row), notice: row.notice },
      role: membership.role,
      members: members.map((member) => this.memberView(member, userId)),
      requestCount: canManage(membership.role) ? await this.repo.countRequestsOfGuild(row.id, this.requestCutoff()) : 0,
      myRequests: [],
    };
  }

  /** Name search (substring, case-insensitive) or recommended guilds; `requested` flags the player's applications. */
  async list(userId: string, query: string) {
    const search = query.trim() || null;
    const profile = await this.repo.profileOf(userId);
    const rows = await this.repo.listGuilds({
      search,
      playerLevel: profile?.level ?? 1,
      maxMembers: this.cfg.maxMembers,
      limit: GUILD_LIST_SIZE,
    });
    const requested = new Set((await this.repo.listRequestsOfUser(userId, this.requestCutoff())).map((request) => request.guildId));
    return { ok: true, guilds: rows.map((row) => ({ ...this.guildView(row), requested: requested.has(row.id) })) };
  }

  /** Public page of a guild: summary and member list (no notice, no member handles). */
  async details(userId: string, guildId: string) {
    const row = await this.repo.findGuildRow(guildId);
    if (!row) throw new AppError(ErrorCode.GUILD_NOT_FOUND);
    const members = await this.repo.listMemberProfiles(guildId, new Date(this.deps.clock.nowMs() - ONLINE_WINDOW_MS));
    const request = await this.repo.findRequestFor(guildId, userId);
    return {
      ok: true,
      guild: this.guildView(row),
      members: members.map((member) => ({ name: member.name, level: member.level, iconId: member.iconId, role: member.role, online: member.online })),
      requested: !!request && request.createdAt >= this.requestCutoff(),
    };
  }

  /** Normalized name and whether it can be used right now (`reason` = error code when not). */
  async checkName(name: string) {
    const normalized = normalizeGuildName(name, this.cfg);
    if ("error" in normalized) return { ok: true, name: name.trim(), available: false, reason: normalized.error };
    const taken = await this.repo.isNameTaken(normalized.key);
    return { ok: true, name: normalized.name, available: !taken, ...(taken ? { reason: ErrorCode.GUILD_NAME_TAKEN } : {}) };
  }

  /** Pending requests of the player's guild (leader and officers). */
  async listRequests(userId: string) {
    const membership = await this.repo.findMembership(userId);
    if (!membership) throw new AppError(ErrorCode.GUILD_NOT_MEMBER);
    if (!canManage(membership.role)) throw new AppError(ErrorCode.GUILD_NO_PERMISSION);
    const rows = await this.repo.listRequestsOfGuild(membership.guildId, this.requestCutoff());
    return {
      ok: true,
      requests: rows.map((row) => ({
        requestId: row.id,
        name: row.name,
        level: row.level,
        iconId: row.iconId,
        createdAt: row.createdAt.toISOString(),
        expiresAt: this.expiryOf(row.createdAt),
      })),
    };
  }

  // ── Membership ────────────────────────────────────────────────────────

  /** Creates a guild led by the player, paying `creationCost`. Returns the new state (+ `wallet` when paid). */
  async create(userId: string, input: GuildCreateInput) {
    const cfg = this.cfg;
    const name = normalizeGuildName(input.name, cfg);
    if ("error" in name) throw new AppError(name.error);
    const description = this.text(input.description, cfg.maxDescriptionLength);
    this.guardTexts(name.name, description);
    const iconId = this.icon(input.iconId);
    const tags = this.tags(input.tags);

    let createdId = "";
    const wallet = await this.deps.uow.transaction(async (session) => {
      if (await this.repo.findMembership(userId, session)) throw new AppError(ErrorCode.GUILD_ALREADY_MEMBER);
      const level = (await this.repo.profileOf(userId, session))?.level ?? 1;
      if (level < cfg.minLevelToCreate) {
        throw new AppError(ErrorCode.GUILD_LEVEL_TOO_LOW, { fields: { requiredLevel: cfg.minLevelToCreate } });
      }
      if (await this.repo.isNameTaken(name.key, session)) throw new AppError(ErrorCode.GUILD_NAME_TAKEN);

      const cost = cfg.creationCost;
      const paid: WalletSnapshot | null = cost && cost.amount > 0 ? await this.deps.ledger.debit(session, userId, [cost]) : null;

      const guildId = this.newGuildId();
      createdId = guildId;
      await this.duplicateAs(ErrorCode.GUILD_NAME_TAKEN, () => this.repo.insertGuild({
        id: guildId,
        name: name.name,
        nameKey: name.key,
        description,
        notice: "",
        iconId,
        tags,
        joinType: input.joinType,
        minLevel: input.minLevel,
        memberCount: 1,
      }, session));
      await this.duplicateAs(ErrorCode.GUILD_ALREADY_MEMBER, () =>
        this.repo.insertMember({ userId, guildId, publicId: this.newPublicId(), role: "leader" }, session));
      await this.repo.deleteRequestsOfUser(userId, session);
      return paid;
    });

    await this.emit({ kind: "created", guildId: createdId, userId });
    const state = await this.getState(userId);
    return wallet ? { ...state, wallet } : state;
  }

  /** Joins an open guild right away, or sends a join request to a guild that requires approval. */
  async join(userId: string, guildId: string) {
    const cfg = this.cfg;
    let joinedId = "";
    const outcome = await this.deps.uow.transaction(async (session) => {
      const guild = await this.repo.findGuild(guildId, session, true);
      if (!guild) throw new AppError(ErrorCode.GUILD_NOT_FOUND);
      if (await this.repo.findMembership(userId, session)) throw new AppError(ErrorCode.GUILD_ALREADY_MEMBER);

      const level = (await this.repo.profileOf(userId, session))?.level ?? 1;
      if (level < guild.minLevel) throw new AppError(ErrorCode.GUILD_LEVEL_TOO_LOW, { fields: { requiredLevel: guild.minLevel } });
      if (guild.memberCount >= cfg.maxMembers) throw new AppError(ErrorCode.GUILD_FULL);

      if (guild.joinType === "open") {
        await this.addMember(guild.id, userId, session);
        joinedId = guild.id;
        return "joined" as const;
      }

      const cutoff = this.requestCutoff();
      await this.repo.deleteExpiredRequestsOfUser(userId, cutoff, session);
      if (await this.repo.findRequestFor(guild.id, userId, session)) throw new AppError(ErrorCode.GUILD_REQUEST_EXISTS);
      if (await this.repo.countRequestsOfUser(userId, cutoff, session) >= cfg.maxPendingRequestsPerUser) {
        throw new AppError(ErrorCode.GUILD_REQUEST_LIMIT, { fields: { limit: cfg.maxPendingRequestsPerUser } });
      }
      await this.duplicateAs(ErrorCode.GUILD_REQUEST_EXISTS, () =>
        this.repo.insertRequest({ id: this.newPublicId(), guildId: guild.id, userId }, session));
      return "requested" as const;
    });
    if (outcome === "joined") await this.emit({ kind: "joined", guildId: joinedId, userId });

    return { ...(await this.getState(userId)), joined: outcome === "joined", requested: outcome === "requested" };
  }

  async cancelRequest(userId: string, guildId: string) {
    await this.deps.uow.transaction(async (session) => {
      const request = await this.repo.findRequestFor(guildId, userId, session);
      if (!request) throw new AppError(ErrorCode.GUILD_REQUEST_NOT_FOUND);
      await this.repo.deleteRequest(request.id, session);
    });
    return this.getState(userId);
  }

  /** Leaves the guild. The leader must transfer the lead first unless alone, which disbands the guild. */
  async leave(userId: string) {
    let leftId = "";
    const disbanded = await this.deps.uow.transaction(async (session) => {
      const { me, guild } = await this.lockActorGuild(userId, session, false);
      leftId = guild.id;
      if (me.role === "leader") {
        const members = await this.repo.listMembers(guild.id, session);
        if (members.some((member) => member.userId !== userId)) throw new AppError(ErrorCode.GUILD_LEADER_MUST_TRANSFER);
        await this.repo.deleteGuild(guild.id, session);
        return true;
      }
      await this.repo.deleteMember(userId, session);
      await this.repo.addMemberCount(guild.id, -1, session);
      return false;
    });
    await this.emit({ kind: "left", guildId: leftId, userId, disbanded });
    return { ...(await this.getState(userId)), disbanded };
  }

  async acceptRequest(userId: string, requestId: string) {
    const cfg = this.cfg;
    let accepted: string | null = null;
    let acceptedInto = "";
    const stale = await this.deps.uow.transaction(async (session) => {
      accepted = null; // re-run after a deadlock: start clean
      const { guild } = await this.lockActorGuild(userId, session, true);
      const request = await this.repo.findRequest(requestId, session, true);
      if (!request || request.guildId !== guild.id) throw new AppError(ErrorCode.GUILD_REQUEST_NOT_FOUND);
      if (request.createdAt < this.requestCutoff()) {
        await this.repo.deleteRequest(request.id, session);
        return ErrorCode.GUILD_REQUEST_NOT_FOUND;
      }
      if (await this.repo.findMembership(request.userId, session)) {
        // Joined another guild in the meantime: the request is useless.
        await this.repo.deleteRequest(request.id, session);
        return ErrorCode.GUILD_ALREADY_MEMBER;
      }
      if (guild.memberCount >= cfg.maxMembers) throw new AppError(ErrorCode.GUILD_FULL);
      await this.addMember(guild.id, request.userId, session);
      await this.notice(session, request.userId, guild.name, "accepted");
      accepted = request.userId;
      acceptedInto = guild.id;
      return null;
    });
    if (stale) throw new AppError(stale);
    await this.notify(accepted);
    if (accepted) await this.emit({ kind: "joined", guildId: acceptedInto, userId: accepted });
    return this.getState(userId);
  }

  async rejectRequest(userId: string, requestId: string) {
    const rejected = await this.deps.uow.transaction(async (session) => {
      const { guild } = await this.lockActorGuild(userId, session, true);
      const request = await this.repo.findRequest(requestId, session, true);
      if (!request || request.guildId !== guild.id) throw new AppError(ErrorCode.GUILD_REQUEST_NOT_FOUND);
      await this.repo.deleteRequest(request.id, session);
      await this.notice(session, request.userId, guild.name, "rejected");
      return request.userId;
    });
    await this.notify(rejected);
    return this.getState(userId);
  }

  async kick(userId: string, memberId: string) {
    let kickedFrom = "";
    const kicked = await this.deps.uow.transaction(async (session) => {
      const { me, guild } = await this.lockActorGuild(userId, session, true);
      const target = await this.repo.findMemberByPublicId(guild.id, memberId, session);
      if (!target || target.userId === userId) throw new AppError(ErrorCode.GUILD_INVALID_TARGET);
      if (!canKick(me.role, target.role)) throw new AppError(ErrorCode.GUILD_NO_PERMISSION);
      await this.repo.deleteMember(target.userId, session);
      await this.repo.addMemberCount(guild.id, -1, session);
      await this.notice(session, target.userId, guild.name, "kicked");
      kickedFrom = guild.id;
      return target.userId;
    });
    await this.notify(kicked);
    await this.emit({ kind: "kicked", guildId: kickedFrom, userId: kicked });
    return this.getState(userId);
  }

  /** Leader only: promotes a member to officer (up to `maxOfficers`) or demotes an officer. */
  async setRole(userId: string, memberId: string, role: "officer" | "member") {
    const cfg = this.cfg;
    let roleGuild = "";
    const changed = await this.deps.uow.transaction(async (session) => {
      const { me, guild } = await this.lockActorGuild(userId, session, false);
      if (me.role !== "leader") throw new AppError(ErrorCode.GUILD_NO_PERMISSION);
      const target = await this.repo.findMemberByPublicId(guild.id, memberId, session);
      if (!target || target.userId === userId || target.role === "leader") throw new AppError(ErrorCode.GUILD_INVALID_TARGET);
      if (target.role === role) return null;
      if (role === "officer") {
        const officers = (await this.repo.listMembers(guild.id, session)).filter((member) => member.role === "officer").length;
        if (officers >= cfg.maxOfficers) throw new AppError(ErrorCode.GUILD_OFFICER_LIMIT, { fields: { limit: cfg.maxOfficers } });
      }
      await this.repo.setRole(target.userId, role, session);
      await this.notice(session, target.userId, guild.name, role === "officer" ? "promoted" : "demoted");
      roleGuild = guild.id;
      return target.userId;
    });
    await this.notify(changed);
    if (changed) await this.emit({ kind: role === "officer" ? "promoted" : "demoted", guildId: roleGuild, userId: changed });
    return this.getState(userId);
  }

  /** Leader only: hands the lead to another member; the old leader becomes officer (member when officers are full). */
  async transfer(userId: string, memberId: string) {
    const cfg = this.cfg;
    let leaderGuild = "";
    const leader = await this.deps.uow.transaction(async (session) => {
      const { me, guild } = await this.lockActorGuild(userId, session, false);
      if (me.role !== "leader") throw new AppError(ErrorCode.GUILD_NO_PERMISSION);
      const target = await this.repo.findMemberByPublicId(guild.id, memberId, session);
      if (!target || target.userId === userId) throw new AppError(ErrorCode.GUILD_INVALID_TARGET);

      const officers = (await this.repo.listMembers(guild.id, session))
        .filter((member) => member.role === "officer" && member.userId !== target.userId).length;
      await this.repo.setRole(target.userId, "leader", session);
      await this.repo.setRole(userId, officers < cfg.maxOfficers ? "officer" : "member", session);
      await this.notice(session, target.userId, guild.name, "leader");
      leaderGuild = guild.id;
      return target.userId;
    });
    await this.notify(leader);
    await this.emit({ kind: "leader", guildId: leaderGuild, userId: leader });
    return this.getState(userId);
  }

  /** Leader and officers: description, notice, emblem, tags, join type and level requirement (only the given fields). */
  async updateSettings(userId: string, input: GuildSettingsInput) {
    const cfg = this.cfg;
    const patch: GuildPatch = {};
    if (input.description !== undefined) patch.description = this.text(input.description, cfg.maxDescriptionLength);
    if (input.notice !== undefined) patch.notice = this.text(input.notice, cfg.maxNoticeLength);
    this.guardTexts(patch.description, patch.notice);
    if (input.iconId !== undefined) patch.iconId = this.icon(input.iconId);
    if (input.tags !== undefined) patch.tags = this.tags(input.tags);
    if (input.joinType !== undefined) patch.joinType = input.joinType;
    if (input.minLevel !== undefined) patch.minLevel = input.minLevel;

    await this.deps.uow.transaction(async (session) => {
      const { guild } = await this.lockActorGuild(userId, session, true);
      await this.repo.updateGuild(guild.id, patch, session);
    });
    return this.getState(userId);
  }

  // ── Operator (GM panel) ───────────────────────────────────────────────
  // Same rules and notices as the player actions, without an acting member: the GM panel authorizes the call.

  /** Removes a member (any role but the leader) from the guild. */
  async operatorKick(guildId: string, memberId: string): Promise<{ userId: string }> {
    const kicked = await this.deps.uow.transaction(async (session) => {
      const guild = await this.lockGuild(guildId, session);
      const target = await this.repo.findMemberByPublicId(guild.id, memberId, session);
      if (!target || target.role === "leader") throw new AppError(ErrorCode.GUILD_INVALID_TARGET);
      await this.repo.deleteMember(target.userId, session);
      await this.repo.addMemberCount(guild.id, -1, session);
      await this.notice(session, target.userId, guild.name, "kicked");
      return target.userId;
    });
    await this.notify(kicked);
    await this.emit({ kind: "kicked", guildId, userId: kicked });
    return { userId: kicked };
  }

  /** Hands the lead to a member; the old leader becomes officer (member when officers are full). */
  async operatorTransfer(guildId: string, memberId: string): Promise<{ userId: string; previousLeaderId: string }> {
    const cfg = this.cfg;
    const result = await this.deps.uow.transaction(async (session) => {
      const guild = await this.lockGuild(guildId, session);
      const members = await this.repo.listMembers(guild.id, session, true);
      const target = members.find((member) => member.publicId === memberId);
      const leader = members.find((member) => member.role === "leader");
      if (!target || target.role === "leader") throw new AppError(ErrorCode.GUILD_INVALID_TARGET);

      const officers = members.filter((member) => member.role === "officer" && member.userId !== target.userId).length;
      await this.repo.setRole(target.userId, "leader", session);
      if (leader) await this.repo.setRole(leader.userId, officers < cfg.maxOfficers ? "officer" : "member", session);
      await this.notice(session, target.userId, guild.name, "leader");
      return { userId: target.userId, previousLeaderId: leader?.userId ?? "" };
    });
    await this.notify(result.userId);
    await this.emit({ kind: "leader", guildId, userId: result.userId });
    return result;
  }

  /** Deletes the guild; every member is told they were removed. */
  async operatorDisband(guildId: string): Promise<{ members: number }> {
    const userIds = await this.deps.uow.transaction(async (session) => {
      const guild = await this.lockGuild(guildId, session);
      const members = await this.repo.listMembers(guild.id, session, true);
      for (const member of members) await this.notice(session, member.userId, guild.name, "kicked");
      await this.repo.deleteGuild(guild.id, session);
      return members.map((member) => member.userId);
    });
    if (this.deps.mail && userIds.length > 0) await this.deps.mail.notify(userIds);
    // Every member lost the guild: their live guild chat connections drop the stale guild (no system line, it is gone).
    for (const userId of userIds) await this.emit({ kind: "kicked", guildId, userId, disbanded: true });
    return { members: userIds.length };
  }

  /** Removes one player from whatever guild they are in (a leader hands the lead to the oldest officer / member). */
  async operatorRemoveMember(userId: string): Promise<{ guildId: string; disbanded: boolean }> {
    const known = await this.repo.findMembership(userId);
    if (!known) throw new AppError(ErrorCode.GUILD_NOT_MEMBER);
    const guildId = known.guildId;
    const disbanded = await this.deps.uow.transaction(async (session) => {
      const guild = await this.repo.findGuild(guildId, session, true);
      if (!guild) throw new AppError(ErrorCode.GUILD_NOT_MEMBER);
      const wasAlone = (await this.repo.listMembers(guildId, session, true)).every((member) => member.userId === userId);
      await this.removeAccounts([userId], session);
      if (!wasAlone) await this.notice(session, userId, guild.name, "kicked");
      return wasAlone;
    });
    if (!disbanded) await this.notify(userId);
    await this.emit({ kind: "kicked", guildId, userId, ...(disbanded ? { disbanded: true } : {}) });
    return { guildId, disbanded };
  }

  /** Edits the name (same normalization and uniqueness as creation) and/or the public texts of a guild. */
  async operatorUpdate(guildId: string, input: { name?: string; description?: string; notice?: string }): Promise<void> {
    const cfg = this.cfg;
    const patch: GuildPatch = {};
    if (input.description !== undefined) patch.description = this.text(input.description, cfg.maxDescriptionLength);
    if (input.notice !== undefined) patch.notice = this.text(input.notice, cfg.maxNoticeLength);
    let renamed: { name: string; key: string } | null = null;
    if (input.name !== undefined) {
      const name = normalizeGuildName(input.name, cfg);
      if ("error" in name) throw new AppError(name.error);
      renamed = name;
    }

    await this.deps.uow.transaction(async (session) => {
      const guild = await this.lockGuild(guildId, session);
      if (renamed && renamed.name !== guild.name) {
        const sameKey = renamed.key === guild.name.toLowerCase();
        if (!sameKey && await this.repo.isNameTaken(renamed.key, session)) throw new AppError(ErrorCode.GUILD_NAME_TAKEN);
        await this.duplicateAs(ErrorCode.GUILD_NAME_TAKEN, () => this.repo.renameGuild(guildId, renamed!.name, renamed!.key, session));
      }
      await this.repo.updateGuild(guildId, patch, session);
    });
  }

  private async lockGuild(guildId: string, session: DbSession): Promise<GuildRecord> {
    const guild = await this.repo.findGuild(guildId, session, true);
    if (!guild) throw new AppError(ErrorCode.GUILD_NOT_FOUND);
    return guild;
  }

  /**
   * Purge hook (account deletion): removes the players from their guilds inside the purge transaction, promoting a
   * successor when a leader leaves (oldest officer, else oldest member) and deleting guilds left without members.
   */
  async removeAccounts(userIds: string[], session: DbSession): Promise<void> {
    for (const userId of userIds) {
      const known = await this.repo.findMembership(userId, session);
      if (!known) continue;
      await this.repo.findGuild(known.guildId, session, true);
      const me = await this.repo.findMembership(userId, session, true);
      if (!me || me.guildId !== known.guildId) continue;

      // Locking read: the purge transaction's snapshot predates the guild lock.
      const others = (await this.repo.listMembers(me.guildId, session, true)).filter((member) => member.userId !== userId);
      if (others.length === 0) {
        await this.repo.deleteGuild(me.guildId, session);
        continue;
      }
      if (me.role === "leader") {
        const successor = pickSuccessor(others);
        if (successor) {
          await this.repo.setRole(successor.userId, "leader", session);
          const guild = await this.repo.findGuild(me.guildId, session);
          if (guild) await this.notice(session, successor.userId, guild.name, "leader");
        }
      }
      await this.repo.deleteMember(userId, session);
      await this.repo.addMemberCount(me.guildId, -1, session);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Writes a guild notice into the player's mailbox inside the current transaction. */
  private async notice(session: DbSession, userId: string, guildName: string, notice: GuildNotice): Promise<void> {
    const mail = this.deps.mail;
    if (!mail) return;
    const text = GUILD_NOTICES[notice];
    await mail.sendInSession(session, userId, {
      category: "guild",
      sender: guildName,
      titleKey: `text_mail_guild_${notice}_title`,
      bodyKey: `text_mail_guild_${notice}_body`,
      title: text.title,
      body: text.body.replace("{0}", guildName),
      params: [guildName],
    });
  }

  /** Publishes a membership/role change after the commit (best effort: the change itself is already saved). */
  private async emit(event: GuildEvent): Promise<void> {
    const events = this.deps.events;
    if (!events || !event.guildId || !event.userId) return;
    try {
      await events.guildChanged(event);
    } catch (error) {
      logger.warn("guild event listener failed:", (error as Error)?.message ?? error);
    }
  }

  /** Pushes the "new mail" notice after the commit. */
  private async notify(userId: string | null): Promise<void> {
    if (userId && this.deps.mail) await this.deps.mail.notify([userId]);
  }

  /**
   * Locks the actor's guild, then re-reads the actor's membership under that lock (it may have changed since the
   * unlocked lookup). `requireManage` = leader or officer.
   */
  private async lockActorGuild(userId: string, session: DbSession, requireManage: boolean) {
    const known = await this.repo.findMembership(userId);
    if (!known) throw new AppError(ErrorCode.GUILD_NOT_MEMBER);
    const guild = await this.repo.findGuild(known.guildId, session, true);
    if (!guild) throw new AppError(ErrorCode.GUILD_NOT_MEMBER);
    const me = await this.repo.findMembership(userId, session, true);
    if (!me || me.guildId !== guild.id) throw new AppError(ErrorCode.GUILD_NOT_MEMBER);
    if (requireManage && !canManage(me.role)) throw new AppError(ErrorCode.GUILD_NO_PERMISSION);
    return { me, guild };
  }

  /** Adds a plain member (under the guild lock) and drops the player's other requests. */
  private async addMember(guildId: string, userId: string, session: DbSession): Promise<void> {
    await this.duplicateAs(ErrorCode.GUILD_ALREADY_MEMBER, () =>
      this.repo.insertMember({ userId, guildId, publicId: this.newPublicId(), role: "member" }, session));
    await this.repo.addMemberCount(guildId, 1, session);
    await this.repo.deleteRequestsOfUser(userId, session);
  }

  private async duplicateAs(code: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError(code);
      throw error;
    }
  }

  private text(value: string, max: number): string {
    const text = sanitizeGuildText(value, max, this.cfg.allowRichTextInDescription);
    if (text === null) throw new AppError(ErrorCode.GUILD_TEXT_TOO_LONG, { fields: { max } });
    return text;
  }

  /** Word filter (block mode): `TEXT_BLOCKED` when a player-written text contains a banned word. */
  private guardTexts(...texts: Array<string | undefined>): void {
    const guard = this.deps.textGuard;
    if (guard && texts.some((value) => !!value && guard.rejects(value))) throw new AppError(ErrorCode.TEXT_BLOCKED);
  }

  private icon(iconId: string): string {
    const id = iconId.trim();
    if (!this.cfg.icons.some((icon) => icon.isDefault && icon.id === id)) throw new AppError(ErrorCode.GUILD_INVALID_ICON);
    return id;
  }

  private tags(values: string[]): string[] {
    const cfg = this.cfg;
    const tags = values.map((tag) => tag.trim());
    const known = new Set(cfg.tags.map((tag) => tag.id));
    if (tags.length > cfg.maxTags || new Set(tags).size !== tags.length || tags.some((tag) => !known.has(tag))) {
      throw new AppError(ErrorCode.GUILD_INVALID_TAG);
    }
    return tags;
  }

  private expiryOf(createdAt: Date): string {
    return new Date(createdAt.getTime() + this.cfg.requestExpirationHours * HOUR_MS).toISOString();
  }

  private guildView(row: GuildListRow | (GuildRecord & { leaderName?: string })): GuildViewDto {
    return {
      guildId: row.id,
      name: row.name,
      description: row.description,
      iconId: row.iconId,
      tags: row.tags,
      joinType: row.joinType,
      minLevel: row.minLevel,
      memberCount: row.memberCount,
      maxMembers: this.cfg.maxMembers,
      leaderName: row.leaderName ?? "",
      createdAt: row.createdAt.toISOString(),
    };
  }

  private memberView(member: GuildMemberProfile, selfUserId: string): GuildMemberDto {
    return {
      memberId: member.publicId,
      name: member.name,
      level: member.level,
      iconId: member.iconId,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
      lastActiveAt: iso(member.lastActiveAt),
      online: member.online,
      self: member.userId === selfUserId,
    };
  }
}
