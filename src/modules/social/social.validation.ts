import { z } from "zod";

import { boundedString, id, strictPayload } from "../../shared/validation.js";

/** Requests without parameters. */
export const SocialEmptySchema = strictPayload({});

/** A player chosen from a list (search result, chat line, friends list). */
export const SocialTargetSchema = strictPayload({ targetUserId: id(36) });

/** `friends/request`: a user id or an exact profile name. */
export const FriendRequestSchema = strictPayload({
  targetUserId: id(36).optional(),
  name: boundedString(32, 1).optional(),
}).refine((value) => !!value.targetUserId !== !!value.name, { message: "targetUserId or name" });

export const FriendRequestIdSchema = strictPayload({ requestId: id(26) });

export const FriendSearchSchema = strictPayload({ query: boundedString(32) });

const messageId = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const DmHistorySchema = strictPayload({
  targetUserId: id(36),
  /** Page back: lines older than this id. */
  beforeId: messageId.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Same text rules as the chat `send` (the moderation trims it to `config.json > chat` sizes). */
export const DmSendSchema = strictPayload({
  targetUserId: id(36),
  message: z.union([z.string(), z.number(), z.boolean()]).transform((value) => String(value)).pipe(z.string().max(500)),
});

export const DmReadSchema = strictPayload({ targetUserId: id(36), upToId: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

export const ChallengeIdSchema = strictPayload({ challengeId: id(26) });
