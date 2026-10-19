// src/modules/roster/roster.room.ts
// Thin transport for the roster: validation + routing to RosterService.

import { Schema } from "@colyseus/schema";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { RosterService } from "./roster.service.js";
import { EvolveSchema, ExpandSchema, ListSchema, LockSchema, PowerUpSchema, SellSchema, StorageCapsSchema, StorageListSchema, StorageMoveSchema } from "./roster.validation.js";

export class RosterState extends Schema {}

export type RosterRoomDeps = {
  roster: RosterService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
};

export class RosterRoom extends AuthenticatedRoom<RosterState, RosterRoomDeps> {
  state = new RosterState();

  onCreate(): void {
    const { roster, queryLimiter, mutationLimiter } = this.deps;
    const invalidPayloadError = ErrorCode.ROSTER_INVALID_PAYLOAD;

    this.handleAuthenticatedRequest("list", {
      schema: ListSchema,
      invalidPayloadError,
      rateLimit: queryLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.listRoster(userId, dto.offset, dto.limit)) }),
    });

    this.handleAuthenticatedRequest("storage_list", {
      schema: StorageListSchema,
      invalidPayloadError,
      rateLimit: queryLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.storageList(userId, dto.location, dto.offset, dto.limit)) }),
    });

    this.handleAuthenticatedRequest("storage_caps", {
      schema: StorageCapsSchema,
      invalidPayloadError,
      rateLimit: queryLimiter,
      handle: async ({ userId }) => ({ ok: true, ...(await roster.storageCaps(userId)) }),
    });

    this.handleAuthenticatedRequest("storage_move", {
      schema: StorageMoveSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.storageMove(userId, dto.target, dto.uids)) }),
    });

    this.handleAuthenticatedRequest("power_up", {
      schema: PowerUpSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.powerUp(userId, dto.targetUid, dto.fodderUids, dto.requestId)) }),
    });

    this.handleAuthenticatedRequest("evolve", {
      schema: EvolveSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.evolve(userId, dto.targetUid, dto.fodderUids, dto.requestId)) }),
    });

    this.handleAuthenticatedRequest("lock", {
      schema: LockSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.setLocked(userId, dto.uid, dto.locked)) }),
    });

    this.handleAuthenticatedRequest("sell", {
      schema: SellSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.sell(userId, dto.uids, dto.requestId)) }),
    });

    this.handleAuthenticatedRequest("expand", {
      schema: ExpandSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await roster.expand(userId, dto.target, dto.requestId)) }),
    });
  }
}
