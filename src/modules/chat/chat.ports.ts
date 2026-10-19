import type { ChatRow, ChatSenderDto } from "./chat.dto.js";

/** Persistence port for chat history. */
export interface ChatRepository {
  /**
   * Stores a message (`original` = unmasked text, only when the word filter masked it), trims the channel to its
   * newest `capPerChannel` messages and returns the new line id.
   */
  insertMessage(channel: number, userId: string, sender: ChatSenderDto, message: string, capPerChannel: number, original?: string | null): Promise<number | void>;
  /** Newest `limit` messages, oldest first. */
  fetchHistory(channel: number, limit: number): Promise<ChatRow[]>;
}

/** Resolves a player's display name, selected profile icon and account level (null when the profile is missing). */
export type ChatSenderResolver = (userId: string) => Promise<ChatSenderDto | null>;

/** GM chat mute of a player: unix seconds until which every channel refuses their messages (0 = not muted). */
export type ChatMuteSource = (userId: string) => Promise<number>;
