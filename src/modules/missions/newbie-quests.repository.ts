import { and, count, eq, gte, isNotNull } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userCharacters, userRunes } from "../../infrastructure/database/schema/index.js";

/** Counts for the state-based new-player quests (roster and rune inventory of one user). */
export class DrizzleNewbieQuestCounts extends DrizzleRepository {
  constructor(database: Database) {
    super(database);
  }

  async countMonsters(userId: string, minStars: number, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(userCharacters)
      .where(and(eq(userCharacters.userId, userId), gte(userCharacters.stars, minStars)));
    return Number(row?.n ?? 0);
  }

  async countRunes(userId: string, minLevel: number, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(userRunes)
      .where(and(eq(userRunes.userId, userId), gte(userRunes.level, minLevel)));
    return Number(row?.n ?? 0);
  }

  async countEquippedRunes(userId: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(userRunes)
      .where(and(eq(userRunes.userId, userId), isNotNull(userRunes.equippedToUid)));
    return Number(row?.n ?? 0);
  }
}
