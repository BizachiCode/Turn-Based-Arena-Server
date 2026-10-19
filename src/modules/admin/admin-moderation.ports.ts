// GM panel "Chat", "Mail history" and "Audit log": operator read models over what the game already stores.

export type AdminChatScope = "global" | "guild";

export type AdminChatMessage = {
  id: number;
  scope: AdminChatScope;
  /** Global channel number (global scope). */
  channel: number | null;
  /** Guild chat only. */
  guildId: string | null;
  guildName: string | null;
  /** Null for guild system lines. */
  userId: string | null;
  nickname: string;
  level: number;
  /** Text players see (masked by the word filter when it matched). */
  message: string;
  /** What the sender really wrote; only when the word filter masked the line. */
  original: string | null;
  system: boolean;
  createdAt: string;
};

export type AdminChatQuery = {
  scope: AdminChatScope;
  /** Global channel number, or the guild id; null = every channel / guild. */
  channel: number | null;
  guildId: string | null;
  /** Sender (user id) filter. */
  userId: string | null;
  limit: number;
  /** Id of the oldest message already loaded. */
  before: number | null;
};

export type AdminMailBroadcast = {
  id: string;
  title: string;
  sender: string;
  hasRewards: boolean;
  includeNewPlayers: boolean;
  /** Players whose inbox already received it. */
  recipients: number;
  createdAt: string;
  expiresAt: string | null;
  /** Expired or revoked broadcasts are no longer delivered. */
  active: boolean;
};

export type AdminDirectMail = {
  auditId: number;
  userId: string | null;
  username: string | null;
  title: string;
  reason: string | null;
  createdAt: string;
};

export type AdminAuditQuery = {
  kind: string | null;
  /** User id (`audit_events.user_id`). */
  userId: string | null;
  from: Date | null;
  to: Date | null;
  /** Id of the oldest row already loaded. */
  before: number | null;
  limit: number;
};

export type AdminAuditRow = {
  id: number;
  kind: string;
  userId: string | null;
  username: string | null;
  meta: unknown;
  createdAt: string;
};

export type AdminConfigFile = {
  file: string;
  updatedAt: string | null;
  bytes: number;
  /** Top-level version / schema marker of the file when it has one. */
  version: string | null;
  /** Length of the top-level arrays and the key count of the top-level objects (first entries only). */
  counts: Record<string, number>;
};

export interface AdminModerationRepository {
  chatMessages(query: AdminChatQuery): Promise<AdminChatMessage[]>;
  /** Messages kept per global channel (the channel picker). */
  chatChannels(): Promise<Array<{ channel: number; messages: number; lastAt: string }>>;
  deleteChatMessage(scope: AdminChatScope, id: number): Promise<AdminChatMessage | null>;

  broadcasts(limit: number, now: Date): Promise<AdminMailBroadcast[]>;
  /** Mails sent to one player by a GM (audit `GM_MAIL`), newest first. */
  directMails(limit: number, before: number | null): Promise<AdminDirectMail[]>;
  /** Stops a broadcast from being delivered to inboxes that have not received it yet; false when unknown. */
  revokeBroadcast(id: string): Promise<{ title: string } | null>;

  auditLog(query: AdminAuditQuery): Promise<AdminAuditRow[]>;
  auditKinds(): Promise<string[]>;
}
