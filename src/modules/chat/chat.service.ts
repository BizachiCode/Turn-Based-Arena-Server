import { TokenBucketRateLimiter, type RateLimiter } from "../../shared/security/rate-limiter.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type {
  ChatChannelInfoDto,
  ChatDirectoryResponseDto,
  ChatHistoryResponseDto,
  ChatMessageDto,
  ChatRulesDto,
  ChatSenderDto,
  ChatSendResponseDto,
  SendMessageInputDto,
  SendMessageResultDto,
} from "./chat.dto.js";
import type { ChatMuteSource, ChatRepository, ChatSenderResolver } from "./chat.ports.js";
import type { ChatTextFilter } from "./chat-text-filter.js";
import type { ChatOccupancy } from "./chat.occupancy.js";

/** Chat tuning exported from Unity (`config.json > chat`), with defaults. */
export type ChatRulesSource = () => ChatRulesDto;

/**
 * Outcome of {@link ChatService.moderate}: the sanitized text (masked by the word filter), plus the unmasked text in
 * `original` only when the filter changed it; or the error reply to send back.
 */
export type ModerationResult = { ok: true; message: string; original?: string } | { ok: false; reply: ChatSendResponseDto };

type DuplicateState = {
  last: string;
  count: number;
  lastAt: number;
};

const HISTORY_CAP_PER_CHANNEL = 80;
/** The duplicate-message counter only matters within this window (ms). */
const DUPLICATE_WINDOW_MS = 30_000;
/** Expired per-user state (mutes, duplicate counters, rate windows) is dropped at most this often (seconds). */
const PRUNE_INTERVAL_SEC = 60;
const DEFAULT_SENDER: ChatSenderDto = { nickname: "Player", iconId: null, level: 1 };
const ICON_ID_MAX_LENGTH = 64; // chat_messages.icon_id / user_profile.icon_id

function normalizeLevel(level: unknown): number {
  const value = Math.floor(Number(level));
  return Number.isFinite(value) && value >= 1 ? value : 1;
}

function normalizeIconId(iconId: unknown): string | null {
  const value = typeof iconId === "string" ? iconId.trim() : "";
  return value ? value.substring(0, ICON_ID_MAX_LENGTH) : null;
}

function sanitizeMessage(input: string): string {
  return (input || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .substring(0, 300);
}

/**
 * Channel number of a join request: an integer >= 0, anything else (missing, fractional, text...) is channel 0.
 * Both the matchmaking filter and the room use it, so a malformed request can't create rooms of its own.
 */
export function normalizeChannel(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Chat moderation (rate limits, mutes, duplicate detection) and history. State is per process. */
export class ChatService {
  private readonly mutes = new Map<string, number>();
  private readonly duplicates = new Map<string, DuplicateState>();
  private readonly perUserWindow = new Map<string, number[]>();
  private rateLimiter: RateLimiter;
  private limiterSignature = "";
  private lastPruneUnix = 0;

  constructor(
    private readonly repo: ChatRepository,
    private readonly occupancy: ChatOccupancy,
    private readonly resolveSenderOf: ChatSenderResolver,
    private readonly rulesSource: ChatRulesSource,
    private readonly clock: Clock,
    /** Persistent GM mutes (GM panel); the in-memory mutes above are the automatic spam ones. */
    private readonly gmMuteUntil: ChatMuteSource = async () => 0,
    /** Word filter (`config.json > chat > filter`); absent = lines are never filtered. */
    private readonly textFilter: Pick<ChatTextFilter, "filterMessage" | "allowsOriginal"> | null = null,
  ) {
    this.rateLimiter = this.buildLimiter(this.getRules());
  }

  getRules(): ChatRulesDto {
    const chatRules = this.rulesSource();
    return {
      dirInitialPool: Math.max(1, chatRules.dirInitialPool),
      dirMaxPool: Math.max(1, chatRules.dirMaxPool),
      dirRecommended: Math.max(1, chatRules.dirRecommended),
      msgMin: Math.max(1, chatRules.msgMin),
      msgMax: Math.max(1, chatRules.msgMax),
      rateTokensPer10s: Math.max(1, chatRules.rateTokensPer10s),
      rateBurst: Math.max(1, chatRules.rateBurst),
      userWindowSec: Math.max(1, chatRules.userWindowSec),
      userMaxInWindow: Math.max(1, chatRules.userMaxInWindow),
      dupMuteBaseSec: Math.max(1, chatRules.dupMuteBaseSec),
    };
  }

  /** Channel occupancy registry shared by chat rooms of this process. */
  get channels(): ChatOccupancy {
    return this.occupancy;
  }

  /** True when `channel` is inside the configured pool (`0 .. max(dirInitialPool, dirMaxPool) - 1`). */
  isChannelInPool(channel: number, rules = this.getRules()): boolean {
    return Number.isInteger(channel) && channel >= 0 && channel < Math.max(rules.dirInitialPool, rules.dirMaxPool);
  }

  /**
   * Channel list: the default pool (`0 .. dirInitialPool - 1`, empty ones included) plus every other channel that has
   * players. Channels nobody is in are never listed beyond the default pool, so abandoned rooms can't grow it.
   * The suggested channel is the emptiest one below `dirRecommended`; when every listed channel is full, the next
   * channel of the pool (the pool grows up to `dirMaxPool`).
   */
  getDirectorySnapshot(rules = this.getRules()): ChatDirectoryResponseDto {
    const maxPool = Math.max(rules.dirInitialPool, rules.dirMaxPool);
    const occupied = this.occupancy.snapshot().filter((entry) => entry.channel < maxPool);
    const playersOf = new Map(occupied.map((entry) => [entry.channel, entry.players]));

    const channels: ChatChannelInfoDto[] = [];
    for (let channel = 0; channel < rules.dirInitialPool; channel++) channels.push({ channel, players: playersOf.get(channel) ?? 0 });
    for (const entry of occupied) if (entry.channel >= rules.dirInitialPool) channels.push({ ...entry });

    let suggested = channels.reduce((best, current) => {
      const bestIsPreferred = best.players < rules.dirRecommended;
      const currentIsPreferred = current.players < rules.dirRecommended;

      if (currentIsPreferred && !bestIsPreferred) return current;
      if (currentIsPreferred === bestIsPreferred && current.players < best.players) return current;
      return best;
    }).channel;

    if ((playersOf.get(suggested) ?? 0) >= rules.dirRecommended) {
      const listed = new Set(channels.map((entry) => entry.channel));
      for (let channel = rules.dirInitialPool; channel < maxPool; channel++) {
        if (!listed.has(channel)) {
          suggested = channel;
          break;
        }
      }
    }

    const highest = Math.max(...channels.map((entry) => entry.channel), suggested);
    return {
      ok: true,
      suggestedChannel: suggested,
      currentPool: Math.min(maxPool, Math.max(rules.dirInitialPool, highest + 1)),
      maxPool,
      channels,
      serverTimeUnix: this.clock.nowUnix(),
    };
  }

  async getHistory(channel: number, userId: string, limit: number): Promise<ChatHistoryResponseDto> {
    const rows = await this.repo.fetchHistory(channel, limit);
    const messages: ChatMessageDto[] = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      nickname: row.nickname,
      iconId: normalizeIconId(row.icon_id),
      level: normalizeLevel(row.level),
      channel: row.channel,
      message: row.message,
      ...this.originalField(row.original_message),
      serverTimeUnix: Math.floor(new Date(row.created_at).getTime() / 1000),
    }));

    return {
      ok: true,
      channel,
      messages,
      serverTimeUnix: this.clock.nowUnix(),
      muteUntilUnix: Math.max(this.mutes.get(userId) || 0, await this.gmMuteUntil(userId)),
    };
  }

  async sendMessage(input: SendMessageInputDto, rules = this.getRules()): Promise<SendMessageResultDto> {
    const checked = await this.moderate(input.userId, input.ipAddress, input.message, rules);
    if ("reply" in checked) return { reply: checked.reply };
    const message = checked.message;

    const sender = await this.resolveSender(input.userId);
    const id = await this.repo.insertMessage(input.channel, input.userId, sender, message, HISTORY_CAP_PER_CHANNEL, checked.original ?? null);

    return {
      reply: { ok: true, serverTimeUnix: this.clock.nowUnix() },
      broadcast: {
        ...(typeof id === "number" ? { id } : {}),
        userId: input.userId,
        nickname: sender.nickname,
        iconId: sender.iconId,
        level: sender.level,
        channel: input.channel,
        message,
        ...this.originalField(checked.original),
        serverTimeUnix: this.clock.nowUnix(),
      },
    };
  }

  /**
   * Wire field for the unmasked text of a masked line: `{ original }` only when the line was masked and the filter
   * config allows players to opt out of it (`config.json > chat > filter > allowPlayerOptOut`), otherwise nothing.
   * Evaluated per delivery, so a config change applies to history immediately.
   */
  originalField(original: string | null | undefined): { original?: string } {
    return original && this.textFilter?.allowsOriginal() ? { original } : {};
  }

  /**
   * Moderation shared by every chat channel (global channels and guild chat), in this order: per-IP token bucket,
   * active mute (automatic or GM), sanitize + minimum length (longer texts are cut to `msgMax`), per-user window,
   * word filter (`MESSAGE_BLOCKED` in block mode, masked text in mask mode; the unmasked text is returned as
   * `original` when it differs), duplicate mute.
   * Mutes and windows are per player, so a player muted in one channel is muted in all of them.
   * The word filter runs here, once, so global chat and guild chat share it.
   */
  async moderate(userId: string, ipAddress: string, rawMessage: string, rules = this.getRules()): Promise<ModerationResult> {
    const currentUnix = this.clock.nowUnix();
    this.refreshLimiter(rules);
    this.pruneIfDue(currentUnix, rules);

    if (!(await this.rateLimiter.allow(ipAddress))) {
      const muteUntilUnix = currentUnix + 5;
      this.mutes.set(userId, muteUntilUnix);
      return { ok: false, reply: this.error("RATE_LIMIT", muteUntilUnix, currentUnix) };
    }

    const existingMute = Math.max(this.mutes.get(userId) || 0, await this.gmMuteUntil(userId));
    if (currentUnix < existingMute) {
      return { ok: false, reply: this.error("MUTED", existingMute, currentUnix) };
    }

    let message = sanitizeMessage(rawMessage);
    if (message.length < rules.msgMin) {
      return { ok: false, reply: this.error("INVALID", undefined, currentUnix) };
    }

    if (message.length > rules.msgMax) {
      message = message.substring(0, rules.msgMax);
    }

    const windowStart = currentUnix - rules.userWindowSec;
    const currentWindow = (this.perUserWindow.get(userId) || []).filter((timestamp) => timestamp >= windowStart);
    currentWindow.push(currentUnix);
    this.perUserWindow.set(userId, currentWindow);

    if (currentWindow.length > rules.userMaxInWindow) {
      const muteUntilUnix = currentUnix + 10;
      this.mutes.set(userId, muteUntilUnix);
      return { ok: false, reply: this.error("RATE_LIMIT", muteUntilUnix, currentUnix) };
    }

    // Word filter: blocked attempts still count in the window above; duplicates compare the masked text.
    const filtered = this.textFilter?.filterMessage(userId, message) ?? { ok: true as const, text: message, masked: false };
    if (!filtered.ok) return { ok: false, reply: this.error("MESSAGE_BLOCKED", undefined, currentUnix) };
    const original = filtered.masked && filtered.text !== message ? message : undefined;
    message = filtered.text;

    const duplicate = this.duplicates.get(userId) || { last: "", count: 0, lastAt: 0 };
    const nowMs = this.clock.nowMs();
    if (duplicate.last === message && nowMs - duplicate.lastAt < DUPLICATE_WINDOW_MS) {
      duplicate.count += 1;
    } else {
      duplicate.count = 1;
    }
    duplicate.last = message;
    duplicate.lastAt = nowMs;
    this.duplicates.set(userId, duplicate);

    if (duplicate.count >= 4) {
      const muteUntilUnix = currentUnix + Math.min(300, rules.dupMuteBaseSec * (duplicate.count * duplicate.count));
      this.mutes.set(userId, muteUntilUnix);
      return { ok: false, reply: this.error("MUTED", muteUntilUnix, currentUnix) };
    }

    return { ok: true, message, ...(original !== undefined ? { original } : {}) };
  }

  /**
   * Drops expired per-user state so the maps don't grow with every distinct chatter: finished mutes, duplicate counters
   * older than their window and rate windows with no timestamp left inside the window.
   */
  private pruneIfDue(currentUnix: number, rules: ChatRulesDto): void {
    if (currentUnix - this.lastPruneUnix < PRUNE_INTERVAL_SEC) return;
    this.lastPruneUnix = currentUnix;

    for (const [userId, until] of this.mutes) if (currentUnix >= until) this.mutes.delete(userId);

    const nowMs = this.clock.nowMs();
    for (const [userId, duplicate] of this.duplicates) if (nowMs - duplicate.lastAt >= DUPLICATE_WINDOW_MS) this.duplicates.delete(userId);

    const windowStart = currentUnix - rules.userWindowSec;
    for (const [userId, timestamps] of this.perUserWindow) {
      if (!timestamps.some((timestamp) => timestamp >= windowStart)) this.perUserWindow.delete(userId);
    }
  }

  /** Entries held per map (diagnostics and tests). */
  trackedUsers(): { mutes: number; duplicates: number; windows: number } {
    return { mutes: this.mutes.size, duplicates: this.duplicates.size, windows: this.perUserWindow.size };
  }

  /** End of the player's current mute (unix seconds, 0 when not muted). */
  muteUntil(userId: string): number {
    return this.mutes.get(userId) || 0;
  }

  /** Snapshot of the sender's nickname, icon and level (defaults when the profile can't be read). */
  senderOf(userId: string): Promise<ChatSenderDto> {
    return this.resolveSender(userId);
  }

  /** Snapshot of the sender's nickname, icon and level; falls back to defaults when the profile can't be read. */
  private async resolveSender(userId: string): Promise<ChatSenderDto> {
    try {
      const sender = await this.resolveSenderOf(userId);
      if (!sender) return { ...DEFAULT_SENDER };
      return {
        nickname: sender.nickname || DEFAULT_SENDER.nickname,
        iconId: normalizeIconId(sender.iconId),
        level: normalizeLevel(sender.level),
      };
    } catch {
      return { ...DEFAULT_SENDER };
    }
  }

  private buildLimiter(rules: ChatRulesDto): RateLimiter {
    this.limiterSignature = `${rules.rateTokensPer10s}:${rules.rateBurst}`;
    return new TokenBucketRateLimiter({ tokensPerInterval: rules.rateTokensPer10s, intervalMs: 10_000, burst: rules.rateBurst });
  }

  /** Rebuilds the limiter when the live config changed its tuning. */
  private refreshLimiter(rules: ChatRulesDto): void {
    if (`${rules.rateTokensPer10s}:${rules.rateBurst}` !== this.limiterSignature) {
      this.rateLimiter = this.buildLimiter(rules);
    }
  }

  private error(error: string, muteUntilUnix?: number, serverTimeUnix = this.clock.nowUnix()): ChatSendResponseDto {
    return {
      ok: false,
      error,
      muteUntilUnix,
      serverTimeUnix,
    };
  }
}
