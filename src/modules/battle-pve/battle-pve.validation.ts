import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";
import { stageStartShape } from "../map/map.validation.js";

const requestId = z.string().max(64).optional().default("");

export const BattleStartSchema = strictPayload({
  ...stageStartShape,
  requestId,
  ticketId: z.string().max(26).optional().nullable(),
});

export const BattleCommandSchema = strictPayload({
  requestId,
  battleId: z.string().max(64).optional().nullable(),
  actorId: id(),
  skillId: id(),
  targetId: id(),
});

/** `battle_auto`, `battle_surrender`, `battle_result`. */
export const BattleRefSchema = strictPayload({
  requestId,
  battleId: z.string().max(64).optional().nullable(),
});
