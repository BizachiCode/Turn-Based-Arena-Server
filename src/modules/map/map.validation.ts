import { z } from "zod";
import { RequestIdSchema } from "../../shared/kernel/idempotency.js";
import { id, strictPayload } from "../../shared/validation.js";

export const DifficultySchema = z.enum(["Easy", "Normal", "Hard", "Hell"]);

export const stageStartShape = {
  regionId: id(),
  stageId: id(),
  difficulty: DifficultySchema,
  uidsInSlots: z.array(z.string().trim().max(64)).max(10).default([]),
  leaderSlotIndex: z.coerce.number().int().min(0).max(9),
  /** Idempotency key (1..64 of [A-Za-z0-9_-]): a retry with the same id returns the first response. */
  requestId: RequestIdSchema,
};

export const StageStartSchema = strictPayload(stageStartShape);

export const MapProgressSchema = strictPayload({});

export const DungeonStatusSchema = strictPayload({});
export const TowerStatusSchema = strictPayload({});
