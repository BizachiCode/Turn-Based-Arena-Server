import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";

const amountSchema = z.number().int().positive().max(1_000_000_000);

/** `economy` message: `{ type, ...fields }` (unknown fields are rejected). */
export const EconomyMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("get_wallet") }),
  strictPayload({
    type: z.literal("spend"),
    currencyId: id(),
    amount: amountSchema,
    /** Free-form client label (logged only). */
    reason: z.string().max(64).nullable().optional(),
  }),
  strictPayload({
    type: z.literal("fuse"),
    inputCurrencyId: id(),
    quantity: z.number().int().positive().max(1_000_000),
  }),
]);

export type EconomyMessage = z.infer<typeof EconomyMessageSchema>;
