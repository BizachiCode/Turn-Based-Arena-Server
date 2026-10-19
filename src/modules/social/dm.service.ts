// Private messages between friends (and guild mates when `directMessages.allowGuildMembers`): history, conversation
// list with unread counts, send (global chat moderation: rate limits, GM mutes, word filter) and read markers.
// Lines are pushed to the recipient and to the sender's other devices as `social_event` `dm_message`.

import type { SocialConfig } from "../../config/SocialCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { ChatSendResponseDto } from "../chat/chat.dto.js";
import type { ModerationResult } from "../chat/chat.service.js";
import type { DmRepository, DmRow } from "./dm.ports.js";
import type { PlayerStatusReader } from "./player-status.js";
import { OFFLINE, otherOf, playerCard, toUnix, type PlayerCardDto } from "./social.domain.js";
import type { FriendsRepository, PlayerDirectory, PlayerSummary, SocialNotifier } from "./social.ports.js";

/** One private message as a client sees it. */
export type DmMessageDto = {
  id: number;
  /** True when the viewer sent the line. */
  self: boolean;
  message: string;
  /** Unmasked text (word filter opt-out), see `ChatMessageDto.original`. */
  original?: string;
  serverTimeUnix: number;
};

export type DmConversationDto = {
  peer: PlayerCardDto;
  lastMessage: DmMessageDto | null;
  unread: number;
  lastAtUnix: number;
  /** The viewer may write to this peer now (friends, not blocked). */
  canMessage: boolean;
};

/** What the private messages need from the chat: moderation and the word filter opt-out field. */
export type DmChatModeration = {
  moderate(userId: string, ipAddress: string, rawMessage: string): Promise<ModerationResult>;
  originalField(original: string | null | undefined): { original?: string };
};

export type DmServiceDeps = {
  repo: DmRepository;
  friendships: FriendsRepository;
  directory: PlayerDirectory;
  status: PlayerStatusReader;
  chat: DmChatModeration;
  notifier: SocialNotifier;
  uow: UnitOfWork;
  clock: Clock;
  config: () => SocialConfig;
};

export class DmService {
  constructor(private readonly deps: DmServiceDeps) {}

  private rules() {
    const rules = this.deps.config().directMessages;
    if (!rules.enabled) throw new AppError(ErrorCode.DM_DISABLED);
    return rules;
  }

  /** The player's conversations, most recent first, with the last line and the unread count. */
  async conversations(userId: string) {
    const rules = this.rules();
    const threads = await this.deps.repo.threads(userId, rules.maxConversations);
    const peerIds = threads.map((thread) => thread.peerId);
    const [players, status, lines, allowed] = await Promise.all([
      this.deps.directory.findPlayers(peerIds),
      this.deps.status.statusOf(peerIds),
      this.deps.repo.messagesById(threads.map((thread) => thread.lastMessageId)),
      this.allowedPeers(userId, peerIds),
    ]);
    const byId = new Map(players.map((player) => [player.userId, player]));
    const lineById = new Map(lines.map((line) => [line.id, line]));
    let unreadTotal = 0;
    const conversations: DmConversationDto[] = [];
    for (const thread of threads) {
      const peer = byId.get(thread.peerId);
      if (!peer) continue;
      const last = lineById.get(thread.lastMessageId);
      unreadTotal += thread.unread;
      conversations.push({
        peer: playerCard(peer, status.get(peer.userId) ?? OFFLINE, allowed.friends.has(peer.userId) ? "friend" : allowed.blocked.has(peer.userId) ? "blocked" : "none"),
        lastMessage: last ? this.toDto(last, userId) : null,
        unread: thread.unread,
        lastAtUnix: toUnix(thread.lastAt),
        canMessage: allowed.canMessage.has(peer.userId),
      });
    }
    return { ok: true, conversations, unreadTotal };
  }

  /** Lines with one peer, newest page first (`beforeId` pages back), oldest first in the page. */
  async history(userId: string, peerId: string, beforeId: number | null, limit?: number) {
    const rules = this.rules();
    const peer = await this.requirePeer(userId, peerId);
    const pageSize = Math.max(1, Math.min(rules.historyPageSize, limit ?? rules.historyPageSize));
    const [rows, info, allowed] = await Promise.all([
      this.deps.repo.history(userId, peerId, beforeId, pageSize + 1),
      this.deps.status.statusOne(peerId),
      this.allowedPeers(userId, [peerId]),
    ]);
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(rows.length - pageSize) : rows;
    return {
      ok: true,
      peer: playerCard(peer, info, allowed.friends.has(peerId) ? "friend" : allowed.blocked.has(peerId) ? "blocked" : "none"),
      messages: page.map((row) => this.toDto(row, userId)),
      hasMore,
      canMessage: allowed.canMessage.has(peerId),
    };
  }

  /**
   * Sends a line to a friend. Refused with `DM_NOT_ALLOWED` when they are not friends (or guild mates, when allowed) or
   * either blocked the other; then the global chat moderation answers `RATE_LIMIT` / `MUTED` / `INVALID` /
   * `MESSAGE_BLOCKED` like the chat `send` (with `muteUntilUnix`).
   */
  async send(userId: string, ipAddress: string, peerId: string, rawMessage: string): Promise<{ ok: boolean; error?: string; muteUntilUnix?: number; serverTimeUnix: number; message?: DmMessageDto }> {
    const rules = this.rules();
    const peer = await this.requirePeer(userId, peerId);
    if (!(await this.allowedPeers(userId, [peerId])).canMessage.has(peerId)) throw new AppError(ErrorCode.DM_NOT_ALLOWED);

    const checked = await this.deps.chat.moderate(userId, ipAddress, rawMessage);
    if ("reply" in checked) return { ...(checked.reply as ChatSendResponseDto) };

    const row = await this.deps.uow.transaction((session) => this.deps.repo.insertMessage(
      { senderId: userId, recipientId: peerId, message: checked.message, original: checked.original ?? null },
      rules.historyPerConversation,
      session,
    ));

    const me = await this.deps.directory.findPlayer(userId);
    const sender = me ? { userId: me.userId, name: me.name, iconId: me.iconId, level: me.level } : null;
    await this.notify(peerId, { kind: "dm_message", peerUserId: userId, sender, message: this.toDto(row, peerId) });
    // The sender's other devices (the sending one ignores the line it already has: same id).
    await this.notify(userId, { kind: "dm_message", peerUserId: peerId, sender: { userId: peer.userId, name: peer.name, iconId: peer.iconId, level: peer.level }, message: this.toDto(row, userId) });
    return { ok: true, serverTimeUnix: this.deps.clock.nowUnix(), message: this.toDto(row, userId) };
  }

  /** Marks the peer's lines up to `upToId` as read. */
  async read(userId: string, peerId: string, upToId: number) {
    this.rules();
    const unread = await this.deps.repo.markRead(userId, peerId, upToId);
    let unreadTotal = 0;
    for (const value of (await this.deps.repo.unreadByPeer(userId)).values()) unreadTotal += value;
    return { ok: true, unread, unreadTotal };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private async requirePeer(userId: string, peerId: string): Promise<PlayerSummary> {
    if (peerId === userId) throw new AppError(ErrorCode.SOCIAL_SELF);
    const peer = await this.deps.directory.findPlayer(peerId);
    if (!peer) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    return peer;
  }

  /** Which peers the player may write to: friends (or guild mates when allowed) that no block separates. */
  private async allowedPeers(userId: string, peerIds: readonly string[]) {
    const { friendships, directory } = this.deps;
    const [rows, myBlocks] = await Promise.all([friendships.listOf(userId, "accepted"), friendships.listBlocked(userId)]);
    const friends = new Set(rows.map((row) => otherOf(row, userId)));
    const blocked = new Set(myBlocks.map((row) => row.userId));
    const canMessage = new Set<string>();
    const allowGuild = this.deps.config().directMessages.allowGuildMembers;
    const myGuild = allowGuild ? await directory.guildOf(userId) : null;
    for (const peerId of peerIds) {
      if (blocked.has(peerId) || (await friendships.isBlocked(peerId, userId))) continue;
      if (friends.has(peerId)) canMessage.add(peerId);
      else if (myGuild && (await directory.guildOf(peerId))?.guildId === myGuild.guildId) canMessage.add(peerId);
    }
    return { friends, blocked, canMessage };
  }

  private toDto(row: DmRow, viewerId: string): DmMessageDto {
    return {
      id: row.id,
      self: row.senderId === viewerId,
      message: row.message,
      ...this.deps.chat.originalField(row.originalMessage),
      serverTimeUnix: toUnix(row.createdAt),
    };
  }

  private async notify(userId: string, event: { kind: string } & Record<string, unknown>): Promise<void> {
    try {
      await this.deps.notifier.notify(userId, event);
    } catch {
      // best effort: the client re-syncs with dm/history
    }
  }
}
