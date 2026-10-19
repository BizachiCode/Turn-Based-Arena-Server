import type { GuildEventKind } from "../guild/guild.service.js";

/** Guild events that post a system line in the guild chat (every {@link GuildEventKind}). */
export type GuildChatSystemEvent = GuildEventKind;

/** English text of the system lines (`{0}` = player name); clients localize `text_guild_chat_sys_<event>`. */
export const GUILD_CHAT_SYSTEM_TEXTS: Record<GuildChatSystemEvent, string> = {
  created: "{0} founded the guild.",
  joined: "{0} joined the guild.",
  left: "{0} left the guild.",
  kicked: "{0} was removed from the guild.",
  promoted: "{0} is now an officer.",
  demoted: "{0} is no longer an officer.",
  leader: "{0} is now the guild leader.",
};

/** One guild chat line as sent to clients (pushed as `guild_chat_msg`, listed by `history`). */
export interface GuildChatMessageDto {
  /** Increasing line id (dedupe between history and pushes). */
  id: number;
  kind: "user" | "system";
  /** Sender name at send time; for system lines, the player the line is about. */
  nickname: string;
  /** Sender's profile icon at send time (null for system lines or when unknown). */
  iconId: string | null;
  /** Sender's account level at send time (>= 1). */
  level: number;
  /** Player text, or the English text of a system line. */
  message: string;
  /**
   * Unmasked player text; present only when the line was masked AND `chat.filter.allowPlayerOptOut` is on (see
   * `ChatMessageDto.original`). Never set on system lines.
   */
  original?: string;
  /** System lines only: event key (`joined`, `left`, ...). */
  system?: GuildChatSystemEvent;
  /** True when the recipient sent the line. Internal user ids are never sent. */
  self: boolean;
  serverTimeUnix: number;
}

/** `history` answer. */
export interface GuildChatHistoryResponseDto {
  ok: boolean;
  error?: string;
  guildId: string | null;
  guildName: string | null;
  messages: GuildChatMessageDto[];
  serverTimeUnix: number;
  muteUntilUnix?: number;
}

/** `guild_chat_state` push (after joining the room and whenever the player's guild changes). */
export interface GuildChatStateDto {
  inGuild: boolean;
  guildId: string | null;
  guildName: string | null;
  serverTimeUnix: number;
}
