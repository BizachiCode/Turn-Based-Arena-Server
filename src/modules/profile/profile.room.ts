import { Schema } from "@colyseus/schema";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { ProfileService } from "./profile.service.js";
import { ProfileMessageSchema, type ProfileMessage } from "./profile.validation.js";

export class ProfileState extends Schema {}

export type ProfileRoomDeps = {
  profiles: ProfileService;
  limiter: RateLimiter;
};

/** Error codes the Unity client expects for profile failures. */
const CLIENT_ERROR_ALIASES: Record<string, string> = {
  [ErrorCode.PROFILE_NAME_TAKEN]: "NAME_TAKEN",
  [ErrorCode.PROFILE_INVALID_ICON]: "ICON_NOT_FOUND",
  [ErrorCode.INVALID_PAYLOAD]: ErrorCode.SERVER_ERROR,
};

function actionOf(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && type ? type : "error";
}

/** Room `profile`: one request type (`profile`) multiplexed by `payload.type`. */
export class ProfileRoom extends AuthenticatedRoom<ProfileState, ProfileRoomDeps> {
  state = new ProfileState();

  onCreate(): void {
    this.handleAuthenticatedRequest<ProfileMessage>("profile", {
      schema: ProfileMessageSchema,
      rateLimit: this.deps.limiter,
      formatError: (failure, raw) => ({
        action: actionOf(raw),
        ok: false,
        error: CLIENT_ERROR_ALIASES[failure.error] ?? failure.error,
      }),
      handle: async ({ userId }, message) => {
        if (message.type === "change_nickname") {
          return { action: "change_nickname", ok: true, ...(await this.deps.profiles.changeNickname(userId, message.nickname)) };
        }
        return { action: "change_icon", ok: true, ...(await this.deps.profiles.changeIcon(userId, message.iconId)) };
      },
    });
  }
}
