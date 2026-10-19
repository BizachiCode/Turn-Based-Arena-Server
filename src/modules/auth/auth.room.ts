// src/modules/auth/auth.room.ts
// Anonymous room used to obtain credentials. One request type (`auth`) multiplexed by `type`.

import type { AuthContext } from "@colyseus/core";
import { Schema } from "@colyseus/schema";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { BaseRoom } from "../../shared/rooms/base-room.js";
import { forwardedAddressOf } from "../../shared/rooms/client-address.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { guestName } from "../../shared/security/password-hasher.js";
import type { AuthService } from "./auth.service.js";
import { AuthMessageSchema, type AuthMessage } from "./auth.validation.js";

export class AuthState extends Schema {}

export type AuthRoomDeps = {
  auth: AuthService;
  /** Per-IP limiter for credential attempts. */
  limiter: RateLimiter;
  isMaintenanceEnabled: () => boolean;
};

const KNOWN_ACTIONS = new Set(["register", "login", "refresh", "logout", "guest", "cancel_deletion"]);

function actionOf(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && type ? type : "error";
}

export class AuthRoom extends BaseRoom<AuthState, AuthRoomDeps> {
  state = new AuthState();

  /**
   * Anonymous room: records the forwarded address (only with TRUST_PROXY; the rate-limit / audit address is otherwise
   * the socket's remote address, see `shared/rooms/client-address.ts`).
   */
  static async onAuth(_token: string, _options: unknown, context: AuthContext) {
    return { address: forwardedAddressOf(context) };
  }

  onCreate(): void {
    this.handleRequest<AuthMessage>("auth", {
      schema: AuthMessageSchema,
      invalidPayloadError: ErrorCode.AUTH_INVALID_PAYLOAD,
      rateLimit: this.deps.limiter,
      rateLimitError: ErrorCode.AUTH_RATE_LIMIT,
      formatError: (failure, raw) => {
        const action = actionOf(raw);
        const known = KNOWN_ACTIONS.has(action);
        const error = !known && failure.error === ErrorCode.AUTH_INVALID_PAYLOAD ? ErrorCode.AUTH_UNKNOWN_ACTION : failure.error;
        return {
          action: known ? action : "unknown",
          ok: false,
          error,
          ...(failure.extra ? { extra: failure.extra } : {}),
        };
      },
      handle: async ({ address }, message) => {
        if (this.deps.isMaintenanceEnabled() && message.type !== "logout") {
          throw new AppError(ErrorCode.MAINTENANCE);
        }

        const device = { deviceId: "deviceId" in message ? message.deviceId : undefined, ip: address };
        switch (message.type) {
          case "register": {
            const username = message.username?.trim() || guestName();
            const { result, account, snapshot } = await this.deps.auth.register(message.email, username, message.password, {
              ...device,
              userAgent: message.userAgent,
            });
            return { action: "register", ok: true, ...result, account, snapshot };
          }
          case "login": {
            const { result, account, snapshot } = await this.deps.auth.login(message.emailOrUsername, message.password, {
              ...device,
              userAgent: message.userAgent,
            });
            return { action: "login", ok: true, ...result, account, snapshot };
          }
          case "guest": {
            const { result, account, snapshot } = await this.deps.auth.createGuest({ ...device, userAgent: message.userAgent });
            return { action: "guest", ok: true, ...result, account, snapshot };
          }
          case "refresh": {
            const { result, account, snapshot } = await this.deps.auth.refresh(message.userId, message.refreshToken, {
              ...device,
              userAgent: message.userAgent,
            });
            return { action: "refresh", ok: true, ...result, account, snapshot };
          }
          case "cancel_deletion": {
            const { result, account, snapshot } = await this.deps.auth.cancelDeletion(message.emailOrUsername, message.password, {
              ...device,
              userAgent: message.userAgent,
            });
            return { action: "cancel_deletion", ok: true, ...result, account, snapshot };
          }
          case "logout": {
            await this.deps.auth.logout(message.userId, message.refreshToken, message.deviceId);
            return { action: "logout", ok: true };
          }
        }
      },
    });
  }

}
