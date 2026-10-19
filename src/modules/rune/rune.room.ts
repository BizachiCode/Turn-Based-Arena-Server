// src/modules/rune/rune.room.ts
// Thin transport for runes: validation + routing to RuneService.

import { Schema } from "@colyseus/schema";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { RuneService } from "./rune.service.js";
import { CountsSchema, EquipSchema, FavoriteSchema, GrantSchema, LockSchema, RuneUidSchema, SearchSchema, UnequipSchema, UpgradeSchema } from "./rune.validation.js";

export class RuneState extends Schema {}

export type RuneRoomDeps = {
  runes: RuneService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
  /** Exposes developer-only actions (`runes/grant`). */
  devTools: boolean;
};

export class RuneRoom extends AuthenticatedRoom<RuneState, RuneRoomDeps> {
  state = new RuneState();

  onCreate(): void {
    const { runes, queryLimiter, mutationLimiter } = this.deps;
    const invalidPayloadError = ErrorCode.RUNE_INVALID_PAYLOAD;

    this.handleAuthenticatedRequest("runes/search", {
      schema: SearchSchema,
      invalidPayloadError,
      rateLimit: queryLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, items: await runes.search(userId, dto) }),
    });

    this.handleAuthenticatedRequest("runes/counts", {
      schema: CountsSchema,
      invalidPayloadError,
      rateLimit: queryLimiter,
      handle: async ({ userId }) => ({ ok: true, items: await runes.setCounts(userId) }),
    });

    // Developer tool: only works when DEV_TOOLS=true (never in production); otherwise FORBIDDEN.
    this.handleAuthenticatedRequest("runes/grant", {
      schema: GrantSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => {
        if (!this.deps.devTools) throw new AppError(ErrorCode.FORBIDDEN);
        const rune = await runes.grant(userId, { ...dto, origin: dto.origin ?? "dev_grant" });
        return { ok: true, uid: rune.uid, rune };
      },
    });

    this.handleAuthenticatedRequest("runes/equip", {
      schema: EquipSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => {
        await runes.equip(userId, dto.runeUid, dto.characterUid);
        return { ok: true };
      },
    });

    this.handleAuthenticatedRequest("runes/unequip", {
      schema: UnequipSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => {
        await runes.unequip(userId, dto.characterUid, dto.slot);
        return { ok: true };
      },
    });

    this.handleAuthenticatedRequest("runes/upgrade", {
      schema: UpgradeSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await runes.upgrade(userId, dto.runeUid, dto.requestId)) }),
    });

    this.handleAuthenticatedRequest("runes/sell", {
      schema: RuneUidSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await runes.sell(userId, dto.runeUid)) }),
    });

    this.handleAuthenticatedRequest("runes/delete", {
      schema: RuneUidSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await runes.remove(userId, dto.runeUid)) }),
    });

    this.handleAuthenticatedRequest("runes/lock", {
      schema: LockSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await runes.setLock(userId, dto.runeUid, dto.locked)) }),
    });

    this.handleAuthenticatedRequest("runes/favorite", {
      schema: FavoriteSchema,
      invalidPayloadError,
      rateLimit: mutationLimiter,
      handle: async ({ userId }, dto) => ({ ok: true, ...(await runes.setFavorite(userId, dto.runeUid, dto.favorite)) }),
    });
  }
}
