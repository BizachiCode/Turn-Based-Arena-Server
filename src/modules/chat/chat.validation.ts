import { z } from "zod";
import { strictPayload } from "../../shared/validation.js";

export const ChatHistorySchema = strictPayload({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const ChatSendSchema = strictPayload({
  message: z.union([z.string(), z.number(), z.boolean()]).transform((value) => String(value)).pipe(z.string().max(500)),
});
