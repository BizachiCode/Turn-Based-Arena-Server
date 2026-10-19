import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { ArenaService } from "./arena.service.js";
import {
  ArenaDefenseLogSchema,
  ArenaOpponentsSchema,
  ArenaRankingSchema,
  ArenaSetDefenseSchema,
  ArenaStateSchema,
} from "./arena.validation.js";

export class ArenaState extends Schema {}

export type ArenaRoomDeps = {
  arena: ArenaService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
};

/**
 * Room `arena`: rating/defense/opponents/log/ranking. Battles are served by the `battle_pve` room
 * (`battle_start_arena`), so the battle presenter is shared with PvE.
 */
export class ArenaRoom extends AuthenticatedRoom<ArenaState, ArenaRoomDeps> {
  state = new ArenaState();

  onCreate(): void {
    const { arena, queryLimiter, mutationLimiter } = this.deps;

    this.handleAuthenticatedRequest("arena/state", {
      schema: ArenaStateSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => arena.getState(userId),
    });

    this.handleAuthenticatedRequest("arena/setDefense", {
      schema: ArenaSetDefenseSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => arena.setDefense(userId, { uidsInSlots: req.uidsInSlots, leaderSlotIndex: req.leaderSlotIndex }),
    });

    this.handleAuthenticatedRequest("arena/opponents", {
      schema: ArenaOpponentsSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => arena.getOpponents(userId, req.refresh),
    });

    this.handleAuthenticatedRequest("arena/defenseLog", {
      schema: ArenaDefenseLogSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => arena.getDefenseLog(userId),
    });

    this.handleAuthenticatedRequest("arena/ranking", {
      schema: ArenaRankingSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => arena.getRanking(userId),
    });
  }
}
