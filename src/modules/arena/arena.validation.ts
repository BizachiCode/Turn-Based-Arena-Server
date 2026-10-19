import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";
import { ARENA_MAX_SLOTS } from "./arena.domain.js";

const uidsInSlots = z.array(z.string().trim().max(64)).max(ARENA_MAX_SLOTS).default([]);
const leaderSlotIndex = z.coerce.number().int().min(0).max(ARENA_MAX_SLOTS - 1);

export const ArenaStateSchema = strictPayload({});
export const ArenaDefenseLogSchema = strictPayload({});
export const ArenaRankingSchema = strictPayload({});

export const ArenaSetDefenseSchema = strictPayload({ uidsInSlots, leaderSlotIndex });

export const ArenaOpponentsSchema = strictPayload({ refresh: z.boolean().optional().default(false) });

/** `battle_start_arena` (served by the `battle_pve` room). */
export const ArenaBattleStartSchema = strictPayload({
  opponentId: id(80),
  uidsInSlots,
  leaderSlotIndex,
  requestId: z.string().max(64).optional().default(""),
});
