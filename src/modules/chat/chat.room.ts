import { ServerError, type AuthContext, type Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";
import { addressOf } from "../../shared/rooms/base-room.js";
import { AuthenticatedRoom, type RoomIdentity } from "../../shared/rooms/authenticated-room.js";
import { forwardedAddressOf } from "../../shared/rooms/client-address.js";
import { AppCloseCode } from "../../shared/protocol/close-codes.js";
import { TokenBucketRateLimiter, type RateLimiter } from "../../shared/security/rate-limiter.js";
import { normalizeChannel, type ChatService } from "./chat.service.js";
import { ChatHistorySchema, ChatSendSchema } from "./chat.validation.js";

export class ChatState extends Schema {}

export type ChatRoomDeps = {
  chat: ChatService;
  /** Per-user limiter of `history` (the shared `query` bucket). Defaults to an in-memory bucket of the same size. */
  queryLimiter?: RateLimiter;
};

type ChatCreateOptions = { channel?: number; listOnly?: boolean };

/**
 * Matchmaking rejected the channel (outside the configured pool). Errors thrown while matchmaking become the HTTP status
 * of the `/matchmake` reply, so this must be a valid HTTP code (a 4xxx Colyseus code crashed the response).
 */
const INVALID_CHANNEL_CODE = 400;
/** Same size as the shared `query` bucket (60 requests / 10 s per user). */
const FALLBACK_QUERY_BUCKET = { tokensPerInterval: 60, intervalMs: 10_000, burst: 60 };

/** Per-client data of a joined chat client: it was counted in the channel occupancy. */
type ChatClientData = { counted?: boolean };

/**
 * Chat channel room (`chat`, filtered by `channel` + `listOnly`).
 * `listOnly` rooms are anonymous helpers that only answer the channel list.
 * A channel room is only created for a channel inside the configured pool (0..dirMaxPool-1) and only counts a channel
 * once a player really joined it.
 */
export class ChatRoom extends AuthenticatedRoom<ChatState, ChatRoomDeps> {
  state = new ChatState();
  private channel = 0;
  private listOnly = false;
  private fallbackQueryLimiter: RateLimiter | null = null;

  static async onAuth(token: string, options: any, context: AuthContext): Promise<RoomIdentity | false> {
    // The matchmaking filter reads these options, so malformed values are normalized here: a missing / fractional /
    // textual channel is channel 0 and `listOnly` is a real boolean, instead of every odd value creating its own room.
    if (options && typeof options === "object") {
      if (options.listOnly !== undefined) options.listOnly = !!options.listOnly;
      options.channel = options.listOnly ? 0 : normalizeChannel(options.channel);
    }

    if (options?.listOnly) {
      // Anonymous list-only helper room: no identity, requests requiring a user are rejected.
      return { userId: "", username: "", deviceId: "", accessJti: "", address: forwardedAddressOf(context) };
    }
    return AuthenticatedRoom.onAuth(token, options, context);
  }

  onCreate(options: ChatCreateOptions): void {
    const { chat } = this.deps;
    const rules = chat.getRules();

    this.channel = normalizeChannel(options?.channel);
    this.listOnly = !!options?.listOnly;
    if (!this.listOnly && !chat.isChannelInPool(this.channel, rules)) {
      // Rejecting here discards the room: nothing is created for a channel nobody can use.
      throw new ServerError(INVALID_CHANNEL_CODE, "invalid chat channel");
    }
    this.setMetadata({ channel: this.channel, listOnly: this.listOnly });

    if (this.listOnly) {
      this.maxClients = 100;
      this.setPrivate(true);
      this.handleRequest("list", {
        handle: () => ({ ...chat.getDirectorySnapshot(rules) }),
      });
      return;
    }

    const serverTime = () => Math.floor(Date.now() / 1000);
    const queryLimiter = this.deps.queryLimiter ?? (this.fallbackQueryLimiter ??= new TokenBucketRateLimiter(FALLBACK_QUERY_BUCKET));

    this.handleAuthenticatedRequest("history", {
      schema: ChatHistorySchema,
      invalidPayloadError: "INVALID",
      rateLimit: queryLimiter,
      formatError: (failure) => ({
        ok: false,
        error: failure.error,
        channel: this.channel,
        messages: [],
        serverTimeUnix: serverTime(),
      }),
      handle: async ({ userId }, dto) => ({ ...(await chat.getHistory(this.channel, userId, dto.limit ?? 50)) }),
    });

    this.handleAuthenticatedRequest("send", {
      schema: ChatSendSchema,
      invalidPayloadError: "INVALID",
      formatError: (failure) => ({ ok: false, error: failure.error, serverTimeUnix: serverTime() }),
      handle: async ({ userId, client }, dto) => {
        const result = await chat.sendMessage({
          channel: this.channel,
          userId,
          ipAddress: addressOf(client),
          message: dto.message,
        }, chat.getRules());

        if (result.broadcast) this.broadcast("chat_msg", result.broadcast);
        return { ...result.reply };
      },
    });
  }

  onJoin(client: Client): void {
    if (this.listOnly) return;

    // `listOnly` joins are anonymous: they may only reach the list helper rooms, never read a real channel.
    if (!(client.auth as RoomIdentity | undefined)?.userId) {
      throw new ServerError(AppCloseCode.POLICY_VIOLATION, "login required");
    }

    ((client.userData ??= {}) as ChatClientData).counted = true;
    this.deps.chat.channels.increment(this.presence, this.channel);
  }

  onLeave(client: Client, _code?: number): void {
    const data = client.userData as ChatClientData | undefined;
    if (this.listOnly || !data?.counted) return;
    data.counted = false;
    this.deps.chat.channels.decrement(this.presence, this.channel);
  }

  onDispose(): void {
    if (!this.listOnly) this.deps.chat.channels.release(this.channel);
  }
}
