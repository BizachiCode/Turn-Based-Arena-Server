import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";

/** `profile` message: `{ type, ...fields }`. */
export const ProfileMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("change_nickname"), nickname: z.string().max(64) }),
  strictPayload({ type: z.literal("change_icon"), iconId: id(128) }),
]);

export type ProfileMessage = z.infer<typeof ProfileMessageSchema>;
