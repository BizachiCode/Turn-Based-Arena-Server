import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";
import { REPORT_COMMENT_MAX, REPORT_SOURCES } from "./report.rules.js";

/** `report_player`: the reporter is the session user; text is never accepted as evidence, only ids. */
export const ReportPlayerSchema = strictPayload({
  targetUserId: id(36).optional(),
  category: z.string().trim().min(1).max(16),
  comment: z.string().max(REPORT_COMMENT_MAX).optional(),
  messageId: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  source: z.enum(REPORT_SOURCES),
});
