import type { Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";
import { addressOf } from "../../shared/rooms/base-room.js";
import { AuthenticatedRoom, type RoomIdentity } from "../../shared/rooms/authenticated-room.js";
import { TokenBucketRateLimiter, type RateLimiter } from "../../shared/security/rate-limiter.js";
import { ChatHistorySchema, ChatSendSchema } from "./chat.validation.js";
import { GUILD_CHAT_TOPIC, parseGuildChatEvent, routeGuildChatEvent, type GuildChatConnection } from "./guild-chat.fanout.js";
import type { GuildChatAccess } from "./guild-chat.ports.js";
import type { GuildChatService } from "./guild-chat.service.js";

export class GuildChatState extends Schema {}

export type GuildChatRoomDeps = {
  guildChat: GuildChatService;
  queryLimiter: RateLimiter;
  /** Per-user limiter of `send` (before any database work). Defaults to an in-memory bucket sized like the chat rules. */
  sendLimiter?: RateLimiter;
};

/** Default `send` bucket per user: the default chat rules (8 messages / 10 s, burst 12). */
const FALLBACK_SEND_BUCKET = { tokensPerInterval: 8, intervalMs: 10_000, burst: 12 };

/**
 * Per-client data: the guild channel the connection receives (null = none) and a membership version. The version
 * changes with every membership event applied to the connection; lookups that finish after it changed (a kick that
 * arrived while `history` / `send` / `onJoin` were awaiting the database) must not write their older answer back.
 */
type GuildChatUserData = { guildId?: string | null; membershipVersion?: number };

/**
 * Room `guild_chat`: the player's guild channel. Any logged-in player may join; the channel is resolved on the server
 * from `guild_members` (on join, `history` and `send`) and kept current by the guild events, so members only ever
 * receive their own guild's lines and players who leave or are kicked stop receiving them at once.
 * Pushes: `guild_chat_msg` (a line) and `guild_chat_state` (after joining and whenever the player's guild changes).
 */
export class GuildChatRoom extends AuthenticatedRoom<GuildChatState, GuildChatRoomDeps> {
  state = new GuildChatState();
  private fallbackSendLimiter: RateLimiter | null = null;

  private readonly onFanout = (raw: unknown) => {
    const event = parseGuildChatEvent(raw);
    if (event) routeGuildChatEvent(event, this.connections(), Math.floor(Date.now() / 1000));
  };

  onCreate(): void {
    const { guildChat, queryLimiter } = this.deps;
    this.maxClients = 500;
    this.setMetadata({ kind: "guild_chat" });
    void this.presence.subscribe(GUILD_CHAT_TOPIC, this.onFanout);

    const serverTime = () => Math.floor(Date.now() / 1000);
    const sendLimiter = this.deps.sendLimiter ?? (this.fallbackSendLimiter ??= new TokenBucketRateLimiter(FALLBACK_SEND_BUCKET));

    this.handleAuthenticatedRequest("history", {
      schema: ChatHistorySchema,
      invalidPayloadError: "INVALID",
      rateLimit: queryLimiter,
      formatError: (failure) => ({ ok: false, error: failure.error, guildId: null, guildName: null, messages: [], serverTimeUnix: serverTime() }),
      handle: async ({ userId, client }, dto) => {
        const version = this.versionOf(client);
        const { access, ...history } = await guildChat.getHistory(userId, dto.limit ?? 50);
        this.track(client, access, version);
        return { ...history };
      },
    });

    this.handleAuthenticatedRequest("send", {
      schema: ChatSendSchema,
      invalidPayloadError: "INVALID",
      rateLimit: sendLimiter,
      formatError: (failure) => ({ ok: false, error: failure.error, serverTimeUnix: serverTime() }),
      handle: async ({ userId, client }, dto) => {
        const version = this.versionOf(client);
        const result = await guildChat.send(userId, addressOf(client), dto.message);
        this.track(client, result.access, version);
        return { ...result.reply };
      },
    });
  }

  async onJoin(client: Client): Promise<void> {
    const userId = (client.auth as RoomIdentity | undefined)?.userId;
    if (!userId) return;
    const version = this.versionOf(client);
    const access = await this.deps.guildChat.access(userId);
    // A membership event applied while the lookup was running is newer than this answer: keep its state.
    if (!this.track(client, access, version)) return;
    client.send("guild_chat_state", this.deps.guildChat.stateOf(access));
  }

  onDispose(): void {
    this.presence.unsubscribe(GUILD_CHAT_TOPIC, this.onFanout);
  }

  /** Membership version of a connection (read before a database lookup, handed back to {@link track}). */
  private versionOf(client: Client): number {
    return ((client.userData ??= {}) as GuildChatUserData).membershipVersion ?? 0;
  }

  /**
   * Remembers the guild channel of a connection (authoritative lookups also heal missed membership events). Ignored,
   * returning false, when a membership event changed the connection since `version` was read.
   */
  private track(client: Client, access: GuildChatAccess | null, version: number): boolean {
    const data = (client.userData ??= {}) as GuildChatUserData;
    if ((data.membershipVersion ?? 0) !== version) return false;
    data.guildId = access?.guildId ?? null;
    return true;
  }

  private *connections(): Iterable<GuildChatConnection> {
    for (const client of this.clients) {
      const userId = (client.auth as RoomIdentity | undefined)?.userId;
      if (!userId) continue;
      const data = (client.userData ??= {}) as GuildChatUserData;
      yield {
        userId,
        get guildId() { return data.guildId ?? null; },
        set guildId(value: string | null) {
          data.guildId = value;
          data.membershipVersion = (data.membershipVersion ?? 0) + 1;
        },
        send: (type, payload) => client.send(type, payload),
      };
    }
  }
}
