import { z } from "zod";

import { strictPayload } from "../../shared/validation.js";

export const PvpEmptySchema = strictPayload({ requestId: z.string().max(64).optional() });

/** `pvp/team`: the team the player locks in during the prepare phase (validated like an arena attack). */
export const PvpTeamSchema = strictPayload({
  uidsInSlots: z.array(z.string().trim().max(64)).max(10),
  leaderSlotIndex: z.coerce.number().int().min(0).max(9),
  requestId: z.string().max(64).optional(),
});
