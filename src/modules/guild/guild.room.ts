import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { GuildQuestService } from "./guild-quest.service.js";
import type { GuildService } from "./guild.service.js";
import {
  GuildCancelRequestSchema,
  GuildClaimChestSchema,
  GuildClaimQuestSchema,
  GuildCheckNameSchema,
  GuildCreateSchema,
  GuildDetailsSchema,
  GuildJoinSchema,
  GuildLeaveSchema,
  GuildListSchema,
  GuildMemberTargetSchema,
  GuildQuestsSchema,
  GuildRequestDecisionSchema,
  GuildRequestsSchema,
  GuildSetRoleSchema,
  GuildStateSchema,
  GuildUpdateSchema,
} from "./guild.validation.js";

export class GuildState extends Schema {}

export type GuildRoomDeps = {
  guilds: GuildService;
  quests: GuildQuestService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
};

/** Room `guild`: guild state, list/search, creation, applications, member management, settings and guild quests. */
export class GuildRoom extends AuthenticatedRoom<GuildState, GuildRoomDeps> {
  state = new GuildState();

  onCreate(): void {
    const { guilds, quests, queryLimiter, mutationLimiter } = this.deps;

    this.handleAuthenticatedRequest("guild/state", {
      schema: GuildStateSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => guilds.getState(userId),
    });

    this.handleAuthenticatedRequest("guild/list", {
      schema: GuildListSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => guilds.list(userId, req.query),
    });

    this.handleAuthenticatedRequest("guild/details", {
      schema: GuildDetailsSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => guilds.details(userId, req.guildId),
    });

    this.handleAuthenticatedRequest("guild/checkName", {
      schema: GuildCheckNameSchema,
      rateLimit: queryLimiter,
      handle: (_context, req) => guilds.checkName(req.name),
    });

    this.handleAuthenticatedRequest("guild/requests", {
      schema: GuildRequestsSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => guilds.listRequests(userId),
    });

    this.handleAuthenticatedRequest("guild/create", {
      schema: GuildCreateSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.create(userId, req),
    });

    this.handleAuthenticatedRequest("guild/join", {
      schema: GuildJoinSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.join(userId, req.guildId),
    });

    this.handleAuthenticatedRequest("guild/cancelRequest", {
      schema: GuildCancelRequestSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.cancelRequest(userId, req.guildId),
    });

    this.handleAuthenticatedRequest("guild/leave", {
      schema: GuildLeaveSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }) => guilds.leave(userId),
    });

    this.handleAuthenticatedRequest("guild/acceptRequest", {
      schema: GuildRequestDecisionSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.acceptRequest(userId, req.requestId),
    });

    this.handleAuthenticatedRequest("guild/rejectRequest", {
      schema: GuildRequestDecisionSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.rejectRequest(userId, req.requestId),
    });

    this.handleAuthenticatedRequest("guild/kick", {
      schema: GuildMemberTargetSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.kick(userId, req.memberId),
    });

    this.handleAuthenticatedRequest("guild/setRole", {
      schema: GuildSetRoleSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.setRole(userId, req.memberId, req.role),
    });

    this.handleAuthenticatedRequest("guild/transfer", {
      schema: GuildMemberTargetSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.transfer(userId, req.memberId),
    });

    this.handleAuthenticatedRequest("guild/update", {
      schema: GuildUpdateSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => guilds.updateSettings(userId, req),
    });

    this.handleAuthenticatedRequest("guild/quests", {
      schema: GuildQuestsSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => quests.getState(userId),
    });

    this.handleAuthenticatedRequest("guild/claimQuest", {
      schema: GuildClaimQuestSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => quests.claimQuest(userId, req.questId),
    });

    this.handleAuthenticatedRequest("guild/claimChest", {
      schema: GuildClaimChestSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => quests.claimChest(userId, req.chestId),
    });
  }
}
