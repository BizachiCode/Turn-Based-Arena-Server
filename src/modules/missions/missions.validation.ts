import { z } from "zod";
import { strictPayload } from "../../shared/validation.js";

const missionId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/);

export const MissionStateSchema = strictPayload({});
export const MissionClaimSchema = strictPayload({ missionId });
export const MissionBonusSchema = strictPayload({});
export const AttendanceStateSchema = strictPayload({});
export const AttendanceClaimSchema = strictPayload({});
export const NewbieQuestStateSchema = strictPayload({});
export const NewbieQuestClaimSchema = strictPayload({ questId: missionId });
export const NewbieChapterClaimSchema = strictPayload({ chapterId: missionId });
