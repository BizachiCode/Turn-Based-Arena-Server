import { Schema } from "@colyseus/schema";

/**
 * PvE battle room uses message-driven snapshots/events.
 * Schema stays intentionally empty while authoritative battle state lives in the server session.
 */
export class BattleRoomPVEState extends Schema {}
