import { Schema } from "@colyseus/schema";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { toWalletItems } from "./economy.mapper.js";
import type { EconomyService } from "./economy.service.js";
import { EconomyMessageSchema, type EconomyMessage } from "./economy.validation.js";

export class EconomyState extends Schema {}

export type EconomyRoomDeps = {
  economy: EconomyService;
  limiter: RateLimiter;
};

function actionOf(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && type ? type : "error";
}

/**
 * Room `economy`: one request type (`economy`) multiplexed by `payload.type`.
 * There is intentionally no "add": currency is only granted by server-owned flows
 * (battle rewards, shop, GM tools).
 */
export class EconomyRoom extends AuthenticatedRoom<EconomyState, EconomyRoomDeps> {
  state = new EconomyState();

  onCreate(): void {
    this.handleAuthenticatedRequest<EconomyMessage>("economy", {
      schema: EconomyMessageSchema,
      rateLimit: this.deps.limiter,
      formatError: (failure, raw) => {
        const action = actionOf(raw);
        const error = failure.error === ErrorCode.INVALID_PAYLOAD && ["spend", "fuse"].includes(action)
          ? ErrorCode.ECON_INVALID_AMOUNT
          : failure.error;
        return { action, ok: false, error, ...(failure.extra ? { extra: failure.extra } : {}) };
      },
      handle: async ({ userId }, message) => {
        switch (message.type) {
          case "get_wallet": {
            const wallet = await this.deps.economy.getWallet(userId);
            return { action: "get_wallet", ok: true, items: toWalletItems(wallet) };
          }
          case "spend": {
            const amount = await this.deps.economy.spend(userId, message.currencyId, message.amount);
            return { action: "spend", ok: true, currencyId: message.currencyId, amount };
          }
          case "fuse": {
            const wallet = await this.deps.economy.fuse(userId, message.inputCurrencyId, message.quantity);
            return { action: "fuse", ok: true, wallet };
          }
        }
      },
    });
  }
}
