import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { UnreadMessages } from "./social.ports.js";

/** Stored private message line. */
export type DmRow = {
  id: number;
  senderId: string;
  recipientId: string;
  message: string;
  /** Unmasked text; only set when the word filter masked the line. */
  originalMessage: string | null;
  createdAt: Date;
};

/** One conversation of a player (`dm_threads`). */
export type DmThreadRow = {
  peerId: string;
  lastMessageId: number;
  lastAt: Date;
  unread: number;
};

export type NewDm = { senderId: string; recipientId: string; message: string; original: string | null };

/** Persistence port of private messages. */
export interface DmRepository extends UnreadMessages {
  /**
   * Stores a line, updates both threads (the recipient's unread count grows; the sender's own line counts as read)
   * and trims the conversation to its newest `capPerConversation` lines.
   */
  insertMessage(row: NewDm, capPerConversation: number, session: DbSession): Promise<DmRow>;
  /** Lines of the conversation older than `beforeId` (null = newest), oldest first. */
  history(userId: string, peerId: string, beforeId: number | null, limit: number): Promise<DmRow[]>;
  /** The player's conversations, most recent first. */
  threads(userId: string, limit: number): Promise<DmThreadRow[]>;
  messagesById(ids: readonly number[]): Promise<DmRow[]>;
  /** Marks the peer's lines up to `upToId` as read; returns the unread lines left in that conversation. */
  markRead(userId: string, peerId: string, upToId: number): Promise<number>;
  findMessage(id: number): Promise<DmRow | null>;
}
