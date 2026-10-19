import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { AttendanceService } from "./attendance.service.js";
import type { MissionService } from "./missions.service.js";
import type { NewbieQuestService } from "./newbie-quests.service.js";
import {
  AttendanceClaimSchema,
  AttendanceStateSchema,
  MissionBonusSchema,
  MissionClaimSchema,
  MissionStateSchema,
  NewbieChapterClaimSchema,
  NewbieQuestClaimSchema,
  NewbieQuestStateSchema,
} from "./missions.validation.js";

export class MissionsState extends Schema {}

export type MissionsRoomDeps = {
  missions: MissionService;
  /** Daily check-in calendar (`attendance/state`, `attendance/claim`); optional. */
  attendance?: AttendanceService;
  /** New-player quest book (`newbie_quests/*`); optional. */
  newbieQuests?: NewbieQuestService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
};

/** Room `missions`: daily missions, the daily bonus, achievements, the daily check-in calendar and the new-player quests. */
export class MissionsRoom extends AuthenticatedRoom<MissionsState, MissionsRoomDeps> {
  state = new MissionsState();

  onCreate(): void {
    const { missions, queryLimiter, mutationLimiter } = this.deps;

    this.handleAuthenticatedRequest("missions/state", {
      schema: MissionStateSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => missions.getState(userId),
    });

    this.handleAuthenticatedRequest("missions/claim", {
      schema: MissionClaimSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => missions.claim(userId, req.missionId),
    });

    this.handleAuthenticatedRequest("missions/claim_bonus", {
      schema: MissionBonusSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }) => missions.claimDailyBonus(userId),
    });

    const { attendance } = this.deps;
    if (attendance) {
      this.handleAuthenticatedRequest("attendance/state", {
        schema: AttendanceStateSchema,
        rateLimit: queryLimiter,
        handle: ({ userId }) => attendance.getState(userId),
      });

      this.handleAuthenticatedRequest("attendance/claim", {
        schema: AttendanceClaimSchema,
        rateLimit: mutationLimiter,
        handle: ({ userId }) => attendance.claim(userId),
      });
    }

    const { newbieQuests } = this.deps;
    if (newbieQuests) {
      this.handleAuthenticatedRequest("newbie_quests/state", {
        schema: NewbieQuestStateSchema,
        rateLimit: queryLimiter,
        handle: ({ userId }) => newbieQuests.getState(userId),
      });

      this.handleAuthenticatedRequest("newbie_quests/claim", {
        schema: NewbieQuestClaimSchema,
        rateLimit: mutationLimiter,
        handle: ({ userId }, req) => newbieQuests.claim(userId, req.questId),
      });

      this.handleAuthenticatedRequest("newbie_quests/claim_chapter", {
        schema: NewbieChapterClaimSchema,
        rateLimit: mutationLimiter,
        handle: ({ userId }, req) => newbieQuests.claimChapter(userId, req.chapterId),
      });
    }
  }
}
