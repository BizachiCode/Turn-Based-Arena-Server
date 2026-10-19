import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";

const mailId = id(16);
/** Batch operations accept up to the largest inbox size. */
const mailIds = z.array(mailId).min(1).max(500);

export const MailListSchema = strictPayload({});
export const MailSummarySchema = strictPayload({});
export const MailReadSchema = strictPayload({ mailIds });
export const MailClaimSchema = strictPayload({ mailId });
export const MailClaimAllSchema = strictPayload({});
export const MailDeleteSchema = strictPayload({ mailIds });
export const MailDeleteReadSchema = strictPayload({});
