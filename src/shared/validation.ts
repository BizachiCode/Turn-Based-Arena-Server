// Edge validation helpers shared by every room schema.

import { z } from "zod";

/** Trimmed string with a hard length cap. */
export const boundedString = (max: number, min = 0) => z.string().trim().min(min).max(max);

/** Opaque identifier (uids, ids, keys). */
export const id = (max = 64) => z.string().trim().min(1).max(max);

/**
 * Strict object: unknown keys are rejected (mass-assignment guard). Identity never comes from the payload,
 * the user is always taken from the authenticated session.
 */
export function strictPayload<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}
