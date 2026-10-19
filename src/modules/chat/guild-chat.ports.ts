import type { ChatSenderDto } from "./chat.dto.js";
import type { GuildChatMessageDto } from "./guild-chat.dto.js";

/** `user` = player message, `system` = guild event line (join, leave, kick, promotion...). */
export type GuildChatKind = "user" | "system";

/** Stored guild chat line (`guild_chat_messages`). */
export interface GuildChatRow {
  id: number;
  guildId: string;
  /** Sender (null for system lines). */
  userId: string | null;
  kind: GuildChatKind;
  nickname: string;
  iconId: string | null;
  level: number;
  /** Player text, or the event key of a system line. */
  message: string;
  /** Unmasked text; only set when the word filter masked the line. */
  originalMessage: string | null;
  createdAt: Date;
}

export type NewGuildChatRow = {
  guildId: string;
  userId: string | null;
  kind: GuildChatKind;
  sender: ChatSenderDto;
  message: string;
  /** Unmasked text, only when the word filter masked the line. */
  original?: string | null;
};

/** Persistence port of the guild chat history. */
export interface GuildChatRepository {
  /** Stores a line, trims the guild to its newest `capPerGuild` lines and returns the new id. */
  insertMessage(row: NewGuildChatRow, capPerGuild: number): Promise<number>;
  /** Newest `limit` lines of the guild, oldest first. */
  fetchHistory(guildId: string, limit: number): Promise<GuildChatRow[]>;
}

/** The player's current guild as seen by the chat. */
export type GuildChatAccess = { guildId: string; guildName: string };

/** Authoritative membership lookup (read from `guild_members` on every join, history and send). */
export interface GuildChatMembership {
  guildOf(userId: string): Promise<GuildChatAccess | null>;
}

/**
 * Events delivered to every `guild_chat` room (all processes). Rooms route `message` events to the clients whose
 * current guild is `guildId`, and apply `membership` events to the clients of `userId`. `senderUserId` never leaves
 * the server: rooms only use it to set the per-recipient `self` flag.
 */
export type GuildChatFanoutEvent =
  | { type: "message"; guildId: string; senderUserId: string | null; message: Omit<GuildChatMessageDto, "self"> }
  | { type: "membership"; userId: string; guildId: string | null; guildName: string | null };

/** Publishes fanout events to the `guild_chat` rooms. Delivery is best effort (clients re-sync with `history`). */
export interface GuildChatFanout {
  publish(event: GuildChatFanoutEvent): void | Promise<void>;
}
