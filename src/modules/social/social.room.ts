import { Schema } from "@colyseus/schema";

import { addressOf } from "../../shared/rooms/base-room.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { DmService } from "./dm.service.js";
import type { FriendlyBattleService } from "./friendly.service.js";
import type { FriendsService } from "./friends.service.js";
import {
  ChallengeIdSchema,
  DmHistorySchema,
  DmReadSchema,
  DmSendSchema,
  FriendRequestIdSchema,
  FriendRequestSchema,
  FriendSearchSchema,
  SocialEmptySchema,
  SocialTargetSchema,
} from "./social.validation.js";

export class SocialState extends Schema {}

export type SocialRoomDeps = {
  friends: FriendsService;
  dms: DmService;
  friendly: FriendlyBattleService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
  /** Per-user bucket of chat lines (shared with the guild chat), checked before any database work. */
  sendLimiter: RateLimiter;
};

/**
 * Room `social` (request room): friends list, requests, search, public profiles, blocks, private messages and friendly
 * battle challenges (the match itself runs in `battle_pvp`). Pushes
 * reach the player through the presence room (`social_event`), so this room can be joined only while a social screen
 * is open.
 */
export class SocialRoom extends AuthenticatedRoom<SocialState, SocialRoomDeps> {
  state = new SocialState();

  onCreate(): void {
    const { friends, dms, friendly, queryLimiter, mutationLimiter, sendLimiter } = this.deps;
    const serverTime = () => Math.floor(Date.now() / 1000);

    this.handleAuthenticatedRequest("friends/summary", { schema: SocialEmptySchema, rateLimit: queryLimiter, handle: ({ userId }) => friends.summary(userId) });
    this.handleAuthenticatedRequest("friends/list", { schema: SocialEmptySchema, rateLimit: queryLimiter, handle: ({ userId }) => friends.list(userId) });
    this.handleAuthenticatedRequest("friends/requests", { schema: SocialEmptySchema, rateLimit: queryLimiter, handle: ({ userId }) => friends.requests(userId) });
    this.handleAuthenticatedRequest("friends/blocked", { schema: SocialEmptySchema, rateLimit: queryLimiter, handle: ({ userId }) => friends.blocked(userId) });
    this.handleAuthenticatedRequest("friends/search", {
      schema: FriendSearchSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => friends.search(userId, req.query),
    });
    this.handleAuthenticatedRequest("friends/profile", {
      schema: SocialTargetSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => friends.profile(userId, req.targetUserId),
    });

    this.handleAuthenticatedRequest("friends/request", {
      schema: FriendRequestSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friends.request(userId, req),
    });
    this.handleAuthenticatedRequest("friends/accept", {
      schema: FriendRequestIdSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friends.accept(userId, req.requestId),
    });
    this.handleAuthenticatedRequest("friends/reject", {
      schema: FriendRequestIdSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friends.reject(userId, req.requestId),
    });
    this.handleAuthenticatedRequest("friends/cancel", {
      schema: FriendRequestIdSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friends.cancel(userId, req.requestId),
    });
    this.handleAuthenticatedRequest("friends/remove", {
      schema: SocialTargetSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friends.remove(userId, req.targetUserId),
    });
    this.handleAuthenticatedRequest("friends/block", {
      schema: SocialTargetSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friends.block(userId, req.targetUserId),
    });
    this.handleAuthenticatedRequest("friends/unblock", {
      schema: SocialTargetSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friends.unblock(userId, req.targetUserId),
    });

    this.handleAuthenticatedRequest("dm/conversations", { schema: SocialEmptySchema, rateLimit: queryLimiter, handle: ({ userId }) => dms.conversations(userId) });
    this.handleAuthenticatedRequest("dm/history", {
      schema: DmHistorySchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => dms.history(userId, req.targetUserId, req.beforeId ?? null, req.limit),
    });
    this.handleAuthenticatedRequest("dm/send", {
      schema: DmSendSchema,
      invalidPayloadError: "INVALID",
      rateLimit: sendLimiter,
      rateLimitError: "RATE_LIMIT",
      formatError: (failure) => ({ ok: false, error: failure.error, serverTimeUnix: serverTime() }),
      handle: ({ userId, client }, req) => dms.send(userId, addressOf(client), req.targetUserId, req.message),
    });
    this.handleAuthenticatedRequest("dm/read", {
      schema: DmReadSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => dms.read(userId, req.targetUserId, req.upToId),
    });

    this.handleAuthenticatedRequest("challenge/list", { schema: SocialEmptySchema, rateLimit: queryLimiter, handle: ({ userId }) => friendly.list(userId) });
    this.handleAuthenticatedRequest("challenge/send", {
      schema: SocialTargetSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friendly.send(userId, req.targetUserId),
    });
    this.handleAuthenticatedRequest("challenge/accept", {
      schema: ChallengeIdSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friendly.accept(userId, req.challengeId),
    });
    this.handleAuthenticatedRequest("challenge/decline", {
      schema: ChallengeIdSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friendly.decline(userId, req.challengeId),
    });
    this.handleAuthenticatedRequest("challenge/cancel", {
      schema: ChallengeIdSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => friendly.cancel(userId, req.challengeId),
    });
  }
}
