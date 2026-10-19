import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { AwakenError } from "./awakening.dto.js";
import type { AwakeningService } from "./awakening.service.js";
import { AwakenSchema, type AwakenInput } from "./awakening.validation.js";

export class AwakeningState extends Schema {}

export type AwakeningRoomDeps = {
  awakening: AwakeningService;
  limiter: RateLimiter;
};

export class AwakeningRoom extends AuthenticatedRoom<AwakeningState, AwakeningRoomDeps> {
  state = new AwakeningState();

  onCreate(): void {
    this.handleAuthenticatedRequest<AwakenInput>("awaken", {
      schema: AwakenSchema,
      invalidPayloadError: AwakenError.INVALID_REQUEST,
      rateLimit: this.deps.limiter,
      handle: ({ userId }, dto) => this.deps.awakening.awaken(userId, dto.characterUid, dto.preview, dto.requestId),
    });
  }
}
