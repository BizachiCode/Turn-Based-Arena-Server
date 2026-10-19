// Zod schemas for the `account` request (multiplexed by `type`).

import { z } from "zod";
import { strictPayload } from "../../shared/validation.js";

export const AccountMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({
    type: z.literal("link_email"),
    email: z.string().email().max(255),
    password: z.string().min(6).max(256),
  }),
  strictPayload({
    type: z.literal("change_password"),
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(6).max(256),
  }),
  strictPayload({ type: z.literal("logout_other_devices") }),
  strictPayload({
    type: z.literal("request_deletion"),
    confirm: z.literal("DELETE"),
    password: z.string().min(1).max(256).optional(),
  }),
]);

export type AccountMessage = z.infer<typeof AccountMessageSchema>;

export const ACCOUNT_ACTIONS = new Set(["info", "link_email", "change_password", "logout_other_devices", "request_deletion"]);
