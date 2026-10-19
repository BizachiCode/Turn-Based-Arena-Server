import { MapState } from "./map.state.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RequestFailure } from "../../shared/rooms/request-handler.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { MapService } from "./map.service.js";
import type { DungeonService } from "../dungeon/dungeon.service.js";
import type { TowerService } from "../tower/tower.service.js";
import { DungeonStatusSchema, MapProgressSchema, StageStartSchema, TowerStatusSchema } from "./map.validation.js";

export type MapRoomDeps = {
  maps: MapService;
  /** Dungeon halls (`dungeon/status`); optional so older setups keep working. */
  dungeons?: DungeonService;
  /** Towers (`tower/status`); optional. */
  towers?: TowerService;
  limiter: RateLimiter;
  queryLimiter: RateLimiter;
};

const MESSAGES: Record<string, string> = {
  [ErrorCode.UNAUTHORIZED]: "Not logged in.",
  [ErrorCode.INVALID_PAYLOAD]: "Invalid request payload.",
  [ErrorCode.RATE_LIMIT]: "Too many requests.",
};

/** Map room errors use `{ ok: false, code, message }`. */
function stageErrorBody(failure: RequestFailure): Record<string, unknown> {
  const code = failure.error === ErrorCode.UNAUTHORIZED ? "INVALID_CREDENTIALS"
    : failure.error === ErrorCode.INVALID_PAYLOAD ? "INVALID_PAYLOAD"
    : failure.error;
  return { ok: false, code, message: failure.message ?? MESSAGES[failure.error] ?? code };
}

/**
 * Room `map`: stage entry validation (pays energy, issues the battle ticket) and progress queries.
 * Stage clears are recorded by the battle room when the server-side battle is won.
 */
export class MapRoom extends AuthenticatedRoom<MapState, MapRoomDeps> {
  state = new MapState();

  onCreate(): void {
    this.setPatchRate(250);

    this.handleAuthenticatedRequest("stage/validateStart", {
      schema: StageStartSchema,
      rateLimit: this.deps.limiter,
      formatError: stageErrorBody,
      handle: ({ userId }, req) => this.deps.maps.validateStageStart(userId, req),
    });

    this.handleAuthenticatedRequest("map/progress", {
      schema: MapProgressSchema,
      rateLimit: this.deps.queryLimiter,
      handle: async ({ userId }) => ({ ok: true, stages: await this.deps.maps.listProgress(userId) }),
    });

    this.handleAuthenticatedRequest("dungeon/status", {
      schema: DungeonStatusSchema,
      rateLimit: this.deps.queryLimiter,
      handle: async ({ userId }) => this.deps.dungeons
        ? this.deps.dungeons.status(userId)
        : { ok: true, serverTimeUnix: Math.floor(Date.now() / 1000), resetHourUtc: 0, nextResetAtUnix: 0, halls: [] },
    });

    this.handleAuthenticatedRequest("tower/status", {
      schema: TowerStatusSchema,
      rateLimit: this.deps.queryLimiter,
      handle: async ({ userId }) => this.deps.towers
        ? this.deps.towers.status(userId)
        : { ok: true, serverTimeUnix: Math.floor(Date.now() / 1000), towers: [] },
    });
  }
}
