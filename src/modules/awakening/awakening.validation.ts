import { z } from "zod";
import { RequestIdSchema } from "../../shared/kernel/idempotency.js";
import { id, strictPayload } from "../../shared/validation.js";

export const AwakenSchema = strictPayload({
  characterUid: id(),
  preview: z.boolean().optional().default(false),
  /** Idempotency key (ignored by previews). */
  requestId: RequestIdSchema,
});

export type AwakenInput = z.infer<typeof AwakenSchema>;
