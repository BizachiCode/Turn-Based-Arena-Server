import { z } from "zod";
import { RequestIdSchema } from "../../shared/kernel/idempotency.js";
import { id, strictPayload } from "../../shared/validation.js";

export const SummonSchema = strictPayload({
  scrollId: id(),
  /** 1 = single summon, 10 = multi summon (grants the scroll's `multiGive`, 10+1 by default). */
  times: z.union([z.literal(1), z.literal(10)]).optional().default(1),
  target: z.enum(["BAG", "STORAGE"]).optional().default("BAG"),
  /** Idempotency key (1..64 of [A-Za-z0-9_-]): a retry with the same id returns the first response. */
  requestId: RequestIdSchema,
});

export type SummonInput = z.infer<typeof SummonSchema>;
