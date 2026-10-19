import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { SummonError, type SummonService } from "./summon.service.js";
import { SummonSchema, type SummonInput } from "./summon.validation.js";

export class SummonState extends Schema {}

export type SummonRoomDeps = {
  summons: SummonService;
  limiter: RateLimiter;
};

export class SummonRoom extends AuthenticatedRoom<SummonState, SummonRoomDeps> {
  state = new SummonState();

  onCreate(): void {
    this.handleAuthenticatedRequest<SummonInput>("summon", {
      schema: SummonSchema,
      invalidPayloadError: SummonError.INVALID_REQUEST,
      rateLimit: this.deps.limiter,
      handle: async ({ userId }, dto) => this.deps.summons.summon(userId, {
        scrollId: dto.scrollId,
        multi: dto.times === 10,
        target: dto.target,
        requestId: dto.requestId,
      }),
    });
  }
}
