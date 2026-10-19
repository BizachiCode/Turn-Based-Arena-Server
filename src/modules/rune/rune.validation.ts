// src/modules/rune/rune.validation.ts

import { z } from "zod";
import { RequestIdSchema } from "../../shared/kernel/idempotency.js";
import { id, strictPayload } from "../../shared/validation.js";

const uid = id();

export const SearchSchema = strictPayload({
  setId: z.string().max(64).optional().nullable(),
  slot: z.number().int().min(1).max(6).optional().nullable(),
  qMin: z.number().int().min(1).max(5).optional().nullable(),
  qMax: z.number().int().min(1).max(5).optional().nullable(),
  lMin: z.number().int().min(0).optional().nullable(),
  lMax: z.number().int().min(0).optional().nullable(),
  equipped: z.boolean().optional().nullable(),
  equippedTo: z.string().max(64).optional().nullable(),
  lastId: z.number().int().optional().nullable(),
  pageSize: z.number().int().min(1).max(200).optional().nullable(),
});

/** `runes/grant` (developer tool): explicit rune spec. */
export const GrantSchema = strictPayload({
  setId: z.string().min(1).max(64),
  slot: z.number().int().min(1).max(6),
  tier: z.number().int().min(1).max(6),
  variant: z.string().min(1).max(32),
  quality: z.number().int().min(1).max(5),
  level: z.number().int().min(0).max(15).optional(),
  mainStatType: z.string().max(64).optional(),
  origin: z.string().max(32).optional(),
});

export const CountsSchema = strictPayload({});
export const EquipSchema = strictPayload({ runeUid: uid, characterUid: uid });
export const UnequipSchema = strictPayload({ characterUid: uid, slot: z.number().int().min(1).max(6) });
export const RuneUidSchema = strictPayload({ runeUid: uid });
/** `runes/upgrade`: the rune plus an optional idempotency key. */
export const UpgradeSchema = strictPayload({ runeUid: uid, requestId: RequestIdSchema });
export const LockSchema = strictPayload({ runeUid: uid, locked: z.boolean() });
export const FavoriteSchema = strictPayload({ runeUid: uid, favorite: z.boolean() });

export type SearchInput = z.infer<typeof SearchSchema>;
export type GrantInput = z.infer<typeof GrantSchema>;
