import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { ShopService } from "./shop.service.js";
import { ShopIapCheckSchema, ShopPurchaseSchema, ShopStateSchema } from "./shop.validation.js";

export class ShopState extends Schema {}

export type ShopRoomDeps = {
  shop: ShopService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
};

/**
 * Room `shop`: purchase counters (`shop/state`), server-validated purchases (`shop/purchase`) and the check before a
 * real-money purchase opens the store payment (`shop/iap_check`).
 */
export class ShopRoom extends AuthenticatedRoom<ShopState, ShopRoomDeps> {
  state = new ShopState();

  onCreate(): void {
    this.handleAuthenticatedRequest("shop/state", {
      schema: ShopStateSchema,
      rateLimit: this.deps.queryLimiter,
      handle: ({ userId }) => this.deps.shop.getState(userId),
    });

    this.handleAuthenticatedRequest("shop/iap_check", {
      schema: ShopIapCheckSchema,
      rateLimit: this.deps.queryLimiter,
      formatError: (failure, raw) => ({
        ok: false,
        error: failure.error,
        itemId: String((raw as { itemId?: unknown } | null)?.itemId ?? ""),
        ...(failure.extra ? { extra: failure.extra } : {}),
      }),
      handle: ({ userId }, req) => this.deps.shop.iapCheck(userId, req.itemId),
    });

    this.handleAuthenticatedRequest("shop/purchase", {
      schema: ShopPurchaseSchema,
      rateLimit: this.deps.mutationLimiter,
      formatError: (failure, raw) => ({
        ok: false,
        error: failure.error,
        itemId: String((raw as { itemId?: unknown } | null)?.itemId ?? ""),
        ...(failure.extra ? { extra: failure.extra } : {}),
        ...(failure.fields ?? {}),
      }),
      handle: ({ userId }, req) => this.deps.shop.purchase(userId, {
        itemId: req.itemId,
        purchaseId: req.purchaseId ?? null,
        expectedPrice: req.expectedPrice ? { currencyId: req.expectedPrice.currencyId ?? null, amount: req.expectedPrice.amount } : null,
        receipt: req.receipt ?? null,
      }),
    });
  }
}
