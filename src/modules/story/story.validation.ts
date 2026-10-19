import { z } from "zod";
import { strictPayload } from "../../shared/validation.js";

const dialogueId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/);

export const StoryStateSchema = strictPayload({});
export const StoryClearSchema = strictPayload({});
export const StoryProgressSchema = strictPayload({ dialogueId, step: z.coerce.number().int().min(0).max(10_000) });
export const StoryCompleteSchema = strictPayload({ dialogueId, skipped: z.boolean().optional().default(false) });
