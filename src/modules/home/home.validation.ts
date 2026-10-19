import { z } from "zod";
import { strictPayload } from "../../shared/validation.js";

const id = z.string().min(1).max(80);
/** Stationed monsters of a production building: 0..10 distinct roster uids. */
const distinctUids = z.array(id).max(10).refine((uids) => new Set(uids).size === uids.length, { message: "uids must be distinct" });
const coord = z.coerce.number().int().min(-10_000).max(10_000);

/** `home` message: `{ type, ...fields }`. */
export const HomeMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("get_snapshot") }),
  strictPayload({
    type: z.literal("place_object"),
    islandId: id,
    definitionId: id,
    originX: coord,
    originZ: coord,
    yawDegrees: z.coerce.number().min(-3600).max(3600).default(0),
  }),
  strictPayload({
    type: z.literal("move_object"),
    islandId: id,
    instanceId: id,
    originX: coord,
    originZ: coord,
    yawDegrees: z.coerce.number().min(-3600).max(3600).default(0),
  }),
  strictPayload({
    type: z.literal("remove_object"),
    islandId: id,
    instanceId: id,
  }),
  strictPayload({
    type: z.literal("unlock_island"),
    islandId: id,
  }),
  strictPayload({
    type: z.literal("collect_production"),
    islandId: id,
    instanceId: id,
  }),
  strictPayload({
    type: z.literal("set_production_units"),
    islandId: id,
    instanceId: id,
    uids: distinctUids,
  }),
]);

export type HomeMessage = z.infer<typeof HomeMessageSchema>;
