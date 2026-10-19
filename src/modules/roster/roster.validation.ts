// src/modules/roster/roster.validation.ts
// Zod schemas for incoming roster requests (strict: unknown fields are rejected).
// The user is always taken from the authenticated session.

import { z } from "zod";
import { RequestIdSchema } from "../../shared/kernel/idempotency.js";
import { id, strictPayload } from "../../shared/validation.js";

const Location = z.enum(["BAG", "STORAGE"]);
const uid = id();

export const ListSchema = strictPayload({
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const StorageListSchema = strictPayload({
  location: Location.optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const StorageCapsSchema = strictPayload({});

export const StorageMoveSchema = strictPayload({
  target: Location,
  uids: z.array(uid).min(1).max(500),
});

export const PowerUpSchema = strictPayload({
  targetUid: uid,
  fodderUids: z.array(uid).min(1).max(100),
  requestId: RequestIdSchema,
});

export const EvolveSchema = strictPayload({
  targetUid: uid,
  fodderUids: z.array(uid).min(1).max(100),
  requestId: RequestIdSchema,
});

export const LockSchema = strictPayload({ uid, locked: z.boolean() });

export const SellSchema = strictPayload({ uids: z.array(uid).min(1).max(100), requestId: RequestIdSchema });

export const ExpandSchema = strictPayload({ target: Location, requestId: RequestIdSchema });
