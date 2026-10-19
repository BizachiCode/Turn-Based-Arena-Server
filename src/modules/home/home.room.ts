import { Schema } from "@colyseus/schema";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { HomeService } from "./home.service.js";
import { HomeMessageSchema, type HomeMessage } from "./home.validation.js";

export class HomeState extends Schema {}

export type HomeRoomDeps = {
  homes: HomeService;
  limiter: RateLimiter;
};

function actionOf(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && type ? type : "error";
}

/** Room `home`: one request type (`home`) multiplexed by `payload.type`. */
export class HomeRoom extends AuthenticatedRoom<HomeState, HomeRoomDeps> {
  state = new HomeState();

  onCreate(): void {
    this.handleAuthenticatedRequest<HomeMessage>("home", {
      schema: HomeMessageSchema,
      invalidPayloadError: ErrorCode.HOME_INVALID_PAYLOAD,
      rateLimit: this.deps.limiter,
      formatError: (failure, raw) => ({ action: actionOf(raw), ok: false, error: failure.error }),
      handle: async ({ userId }, message) => {
        const { homes } = this.deps;
        switch (message.type) {
          case "get_snapshot":
            return { action: "get_snapshot", ok: true, snapshot: await homes.getSnapshot(userId) };
          case "place_object":
            return { action: "place_object", ...(await homes.placeObject(userId, message)) };
          case "move_object":
            return { action: "move_object", ...(await homes.moveObject(userId, message)) };
          case "remove_object":
            return { action: "remove_object", ...(await homes.removeObject(userId, message)) };
          case "unlock_island":
            return { action: "unlock_island", ...(await homes.unlockIsland(userId, message.islandId)) };
          case "collect_production":
            return { action: "collect_production", ...(await homes.collectProduction(userId, message)) };
          case "set_production_units":
            return { action: "set_production_units", ...(await homes.setProductionUnits(userId, message)) };
        }
      },
    });
  }
}
