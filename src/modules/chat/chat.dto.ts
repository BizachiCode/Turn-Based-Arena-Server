export interface ChatRow {
  id: number;
  channel: number;
  user_id: string;
  nickname: string;
  icon_id: string | null;
  level: number;
  message: string;
  /** Unmasked text; only set when the word filter masked the line. */
  original_message: string | null;
  created_at: Date;
}

export interface ChatMessageDto {
  /** Stored line id (`chat_messages.id`); what a player report refers to. Absent on lines that were not stored. */
  id?: number;
  userId: string;
  nickname: string;
  /** Sender's profile icon id snapshotted at send time; null when the sender had no icon (client shows a default avatar). */
  iconId: string | null;
  /** Sender's account level snapshotted at send time (>= 1). */
  level: number;
  channel: number;
  /** Text shown by default (masked by the word filter when it matched). */
  message: string;
  /**
   * Unmasked text. Present only when the line was masked AND `chat.filter.allowPlayerOptOut` is on; the client shows it
   * instead of `message` when the player turned the filter off locally.
   */
  original?: string;
  serverTimeUnix: number;
}

export interface ChatHistoryResponseDto {
  ok: boolean;
  channel: number;
  messages: ChatMessageDto[];
  serverTimeUnix: number;
  error?: string;
  muteUntilUnix?: number;
}

export interface ChatSendResponseDto {
  ok: boolean;
  error?: string;
  muteUntilUnix?: number;
  serverTimeUnix: number;
}

export interface ChatChannelInfoDto {
  channel: number;
  players: number;
}

export interface ChatDirectoryResponseDto {
  ok: boolean;
  suggestedChannel: number;
  currentPool: number;
  maxPool: number;
  channels: ChatChannelInfoDto[];
  serverTimeUnix: number;
}

export interface ChatOccupancyUpdateDto {
  channel: number;
  players: number;
}

export interface ChatRulesDto {
  dirInitialPool: number;
  dirMaxPool: number;
  dirRecommended: number;
  msgMin: number;
  msgMax: number;
  rateTokensPer10s: number;
  rateBurst: number;
  userWindowSec: number;
  userMaxInWindow: number;
  dupMuteBaseSec: number;
}

export interface SendMessageInputDto {
  channel: number;
  userId: string;
  ipAddress: string;
  message: string;
}

/** Sender identity snapshotted into each chat message. */
export interface ChatSenderDto {
  nickname: string;
  iconId: string | null;
  level: number;
}

export interface SendMessageResultDto {
  reply: ChatSendResponseDto;
  broadcast?: ChatMessageDto;
}
