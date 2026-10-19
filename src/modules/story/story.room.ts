import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { StoryService } from "./story.service.js";
import { StoryClearSchema, StoryCompleteSchema, StoryProgressSchema, StoryStateSchema } from "./story.validation.js";

export class StoryState extends Schema {}

export type StoryRoomDeps = {
  story: StoryService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
};

/** Room `story`: dialogue/tutorial progress (completed sequences, the one in progress) and completion rewards. */
export class StoryRoom extends AuthenticatedRoom<StoryState, StoryRoomDeps> {
  state = new StoryState();

  onCreate(): void {
    const { story, queryLimiter, mutationLimiter } = this.deps;

    this.handleAuthenticatedRequest("story/state", {
      schema: StoryStateSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => story.getState(userId),
    });

    this.handleAuthenticatedRequest("story/progress", {
      schema: StoryProgressSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => story.saveProgress(userId, req.dialogueId, req.step),
    });

    this.handleAuthenticatedRequest("story/clear", {
      schema: StoryClearSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => story.clearProgress(userId),
    });

    this.handleAuthenticatedRequest("story/complete", {
      schema: StoryCompleteSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => story.complete(userId, req.dialogueId, req.skipped),
    });
  }
}
