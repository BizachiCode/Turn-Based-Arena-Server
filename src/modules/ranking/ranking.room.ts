import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { RankingService } from "./ranking.service.js";
import { RankingCategoriesSchema, RankingListSchema } from "./ranking.validation.js";

export class RankingState extends Schema {}

export type RankingRoomDeps = {
  ranking: RankingService;
  queryLimiter: RateLimiter;
};

/** Room `ranking`: the enabled leaderboard categories and their top lists (read only, cached by the service). */
export class RankingRoom extends AuthenticatedRoom<RankingState, RankingRoomDeps> {
  state = new RankingState();

  onCreate(): void {
    const { ranking, queryLimiter } = this.deps;

    this.handleAuthenticatedRequest("ranking/categories", {
      schema: RankingCategoriesSchema,
      rateLimit: queryLimiter,
      handle: () => ranking.categories(),
    });

    this.handleAuthenticatedRequest("ranking/list", {
      schema: RankingListSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => ranking.list(userId, req),
    });
  }
}
