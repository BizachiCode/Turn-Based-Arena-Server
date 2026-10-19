// Room `account`: account management for logged-in players. One request type (`account`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { AccountService } from "./account.service.js";
import { ACCOUNT_ACTIONS, AccountMessageSchema, type AccountMessage } from "./account.validation.js";

export class AccountState extends Schema {}

export type AccountRoomDeps = {
  accounts: AccountService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for every state-changing / password-checking action (RATE_LIMITS.account). */
  accountLimiter: RateLimiter;
};

/** Delay before work that must not race the reply (e.g. deleting the caller's own session). */
const AFTER_RESPONSE_DELAY_MS = 250;

function actionOf(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && ACCOUNT_ACTIONS.has(type) ? type : "unknown";
}

export class AccountRoom extends AuthenticatedRoom<AccountState, AccountRoomDeps> {
  state = new AccountState();

  onCreate(): void {
    this.handleAuthenticatedRequest<AccountMessage>("account", {
      schema: AccountMessageSchema,
      formatError: (failure, raw) => ({
        action: actionOf(raw),
        ok: false,
        error: failure.error,
        ...(failure.extra ? { extra: failure.extra } : {}),
      }),
      handle: async ({ userId, identity }, message) => {
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.accountLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);

        // The device always comes from the access token claims, never from the payload.
        const deviceId = identity.deviceId;
        const accounts = this.deps.accounts;

        switch (message.type) {
          case "info":
            return { action: "info", ok: true, account: await accounts.info(userId) };
          case "link_email":
            return { action: "link_email", ok: true, account: await accounts.linkEmail(userId, deviceId, message.email, message.password) };
          case "change_password":
            return {
              action: "change_password",
              ok: true,
              ...(await accounts.changePassword(userId, deviceId, message.currentPassword, message.newPassword)),
            };
          case "logout_other_devices":
            return { action: "logout_other_devices", ok: true, ...(await accounts.logoutOtherDevices(userId, deviceId)) };
          case "request_deletion": {
            const { afterResponse, ...result } = await accounts.requestDeletion(userId, deviceId, message.password);
            this.runAfterResponse(afterResponse);
            return { action: "request_deletion", ok: true, ...result };
          }
        }
      },
    });
  }

  /** Runs `task` once the current reply has been sent (it may revoke the caller's own session). */
  private runAfterResponse(task: () => Promise<void>): void {
    const timer = setTimeout(() => {
      task().catch((error) => this.logger.error("after-response task failed:", error));
    }, AFTER_RESPONSE_DELAY_MS);
    timer.unref?.();
  }
}
