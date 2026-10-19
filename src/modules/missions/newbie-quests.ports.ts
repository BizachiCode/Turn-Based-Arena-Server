import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { StageProgressRecord } from "../map/map.ports.js";

/**
 * Player state read by the state-based new-player quests (`account_level`, `clear_stage`, `own_monsters`,
 * `rune_level`, `equip_runes`). Every query is scoped to the authenticated user.
 */
export interface NewbieQuestFacts {
  accountLevel(userId: string, session?: DbSession): Promise<number>;
  /** Every stage/difficulty cleared at least once. */
  stageClears(userId: string, session?: DbSession): Promise<StageProgressRecord[]>;
  /** Owned monsters (bag + storage) with at least `minStars` stars. */
  countMonsters(userId: string, minStars: number, session?: DbSession): Promise<number>;
  /** Owned runes at `minLevel` or higher. */
  countRunes(userId: string, minLevel: number, session?: DbSession): Promise<number>;
  /** Runes equipped on any monster. */
  countEquippedRunes(userId: string, session?: DbSession): Promise<number>;
}
