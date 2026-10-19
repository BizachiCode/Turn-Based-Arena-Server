// Guild chat: one channel per guild. Access is decided by `guild_members` on every join, history and send (never by
// the payload), messages reuse the global chat moderation (`ChatService.moderate`: rate limits, mutes, sanitizing,
// length, duplicates) and are fanned out to the `guild_chat` rooms, which deliver them only to that guild's members.
// Guild membership/role changes arrive through `GuildEventSink` after their commit: they post system lines and move
// the player's live connections in or out of the guild channel (leaving or being kicked removes access immediately).

import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { createLogger } from "../../shared/logger.js";
import type { GuildEvent, GuildEventSink } from "../guild/guild.service.js";
import type { GuildRepository } from "../guild/guild.ports.js";
import type { ChatSendResponseDto, ChatSenderDto } from "./chat.dto.js";
import type { ChatService } from "./chat.service.js";
import {
  GUILD_CHAT_SYSTEM_TEXTS,
  type GuildChatHistoryResponseDto,
  type GuildChatMessageDto,
  type GuildChatStateDto,
  type GuildChatSystemEvent,
} from "./guild-chat.dto.js";
import type {
  GuildChatAccess,
  GuildChatFanout,
  GuildChatFanoutEvent,
  GuildChatMembership,
  GuildChatRepository,
  GuildChatRow,
} from "./guild-chat.ports.js";

/** Lines kept per guild (same cap as a global channel). */
export const GUILD_CHAT_HISTORY_CAP = 80;

const logger = createLogger("GuildChatService");

export type GuildChatServiceDeps = {
  repo: GuildChatRepository;
  membership: GuildChatMembership;
  /** Global chat service: shared moderation state (mutes, windows), sender snapshots and rules. */
  chat: ChatService;
  fanout: GuildChatFanout;
  clock: Clock;
};

/** `send` outcome: the reply and the player's guild at send time (null without one). */
export type GuildChatSendResult = { reply: ChatSendResponseDto; access: GuildChatAccess | null };

/** Membership lookup over the guild repository (`guild_members` + `guilds`). */
export function guildChatMembershipOf(guilds: Pick<GuildRepository, "findMembership" | "findGuild">): GuildChatMembership {
  return {
    guildOf: async (userId) => {
      const membership = await guilds.findMembership(userId);
      if (!membership) return null;
      const guild = await guilds.findGuild(membership.guildId);
      return guild ? { guildId: guild.id, guildName: guild.name } : null;
    },
  };
}

function isSystemEvent(value: string): value is GuildChatSystemEvent {
  return Object.prototype.hasOwnProperty.call(GUILD_CHAT_SYSTEM_TEXTS, value);
}

export class GuildChatService implements GuildEventSink {
  constructor(private readonly deps: GuildChatServiceDeps) {}

  /** The player's current guild (null without one). */
  access(userId: string): Promise<GuildChatAccess | null> {
    return this.deps.membership.guildOf(userId);
  }

  /** Payload of the `guild_chat_state` push. */
  stateOf(access: GuildChatAccess | null): GuildChatStateDto {
    return {
      inGuild: !!access,
      guildId: access?.guildId ?? null,
      guildName: access?.guildName ?? null,
      serverTimeUnix: this.deps.clock.nowUnix(),
    };
  }

  /** Newest `limit` lines (1..200) of the player's guild, oldest first; `GUILD_NOT_MEMBER` without a guild. */
  async getHistory(userId: string, limit: number): Promise<GuildChatHistoryResponseDto & { access: GuildChatAccess | null }> {
    const access = await this.access(userId);
    const serverTimeUnix = this.deps.clock.nowUnix();
    if (!access) {
      return { ok: false, error: ErrorCode.GUILD_NOT_MEMBER, guildId: null, guildName: null, messages: [], serverTimeUnix, access };
    }

    const rows = await this.deps.repo.fetchHistory(access.guildId, Math.max(1, Math.min(200, Math.floor(limit) || 50)));
    return {
      ok: true,
      guildId: access.guildId,
      guildName: access.guildName,
      messages: rows.map((row) => this.toDto(row, userId)),
      serverTimeUnix,
      muteUntilUnix: this.deps.chat.muteUntil(userId),
      access,
    };
  }

  /**
   * Sends a message to the player's guild: membership first (`GUILD_NOT_MEMBER`), then the global chat moderation
   * (`RATE_LIMIT` / `MUTED` / `INVALID`). Accepted lines are stored and fanned out to the guild's members.
   */
  async send(userId: string, ipAddress: string, rawMessage: string): Promise<GuildChatSendResult> {
    const access = await this.access(userId);
    if (!access) {
      return { reply: { ok: false, error: ErrorCode.GUILD_NOT_MEMBER, serverTimeUnix: this.deps.clock.nowUnix() }, access };
    }

    const checked = await this.deps.chat.moderate(userId, ipAddress, rawMessage);
    if ("reply" in checked) return { reply: checked.reply, access };

    const sender = await this.deps.chat.senderOf(userId);
    const id = await this.deps.repo.insertMessage(
      { guildId: access.guildId, userId, kind: "user", sender, message: checked.message, original: checked.original ?? null },
      GUILD_CHAT_HISTORY_CAP,
    );
    const serverTimeUnix = this.deps.clock.nowUnix();
    await this.publish({
      type: "message",
      guildId: access.guildId,
      senderUserId: userId,
      message: { id, kind: "user", nickname: sender.nickname, iconId: sender.iconId, level: sender.level, message: checked.message, ...this.deps.chat.originalField(checked.original), serverTimeUnix },
    });
    return { reply: { ok: true, serverTimeUnix }, access };
  }

  /**
   * Guild change committed by the guild service: posts the system line and updates the live access of the player.
   * Joining players get access before the line (they see it); leaving/kicked players lose it after the line, but the
   * revoke always runs, even when posting the line fails (a kicked member must never keep receiving the guild chat).
   */
  async guildChanged(event: GuildEvent): Promise<void> {
    const entering = event.kind === "created" || event.kind === "joined";
    const leaving = event.kind === "left" || event.kind === "kicked";

    if (entering) await this.publishAccess(event.userId);
    try {
      if (!event.disbanded) await this.postSystemLine(event.guildId, event.userId, event.kind);
    } finally {
      if (leaving) await this.publishAccess(event.userId, true);
    }
  }

  /** Stores and fans out a system line about `userId` (name snapshotted now). */
  private async postSystemLine(guildId: string, userId: string, kind: GuildChatSystemEvent): Promise<void> {
    const subject = await this.deps.chat.senderOf(userId);
    const sender: ChatSenderDto = { nickname: subject.nickname, iconId: null, level: subject.level };
    const id = await this.deps.repo.insertMessage({ guildId, userId: null, kind: "system", sender, message: kind }, GUILD_CHAT_HISTORY_CAP);
    await this.publish({
      type: "message",
      guildId,
      senderUserId: null,
      message: this.systemDto(id, sender.nickname, sender.level, kind, this.deps.clock.nowUnix()),
    });
  }

  /**
   * Re-reads the player's guild and tells the rooms (their connections join or leave the guild channel). When the
   * player left the guild (`leaving`) and the lookup fails, access is revoked anyway: losing a channel is the safe side.
   */
  private async publishAccess(userId: string, leaving = false): Promise<void> {
    let access: GuildChatAccess | null;
    try {
      access = await this.access(userId);
    } catch (error) {
      if (!leaving) throw error;
      logger.warn("guild chat access lookup failed, revoking access:", (error as Error)?.message ?? error);
      access = null;
    }
    await this.publish({ type: "membership", userId, guildId: access?.guildId ?? null, guildName: access?.guildName ?? null });
  }

  private async publish(event: GuildChatFanoutEvent): Promise<void> {
    try {
      await this.deps.fanout.publish(event);
    } catch (error) {
      logger.warn("guild chat fanout failed:", (error as Error)?.message ?? error);
    }
  }

  private toDto(row: GuildChatRow, viewerUserId: string): GuildChatMessageDto {
    const serverTimeUnix = Math.floor(new Date(row.createdAt).getTime() / 1000);
    const level = Math.max(1, Math.floor(Number(row.level)) || 1);
    if (row.kind === "system" && isSystemEvent(row.message)) {
      return { ...this.systemDto(row.id, row.nickname, level, row.message, serverTimeUnix), self: false };
    }
    return {
      id: row.id,
      kind: "user",
      nickname: row.nickname,
      iconId: row.iconId && row.iconId.trim() ? row.iconId : null,
      level,
      message: row.message,
      ...this.deps.chat.originalField(row.originalMessage),
      self: !!row.userId && row.userId === viewerUserId,
      serverTimeUnix,
    };
  }

  private systemDto(id: number, nickname: string, level: number, kind: GuildChatSystemEvent, serverTimeUnix: number): Omit<GuildChatMessageDto, "self"> {
    return {
      id,
      kind: "system",
      nickname,
      iconId: null,
      level,
      message: GUILD_CHAT_SYSTEM_TEXTS[kind].replace("{0}", nickname),
      system: kind,
      serverTimeUnix,
    };
  }
}
