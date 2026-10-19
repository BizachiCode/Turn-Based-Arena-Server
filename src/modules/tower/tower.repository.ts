import { and, eq, ne } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userTowerProgress } from "../../infrastructure/database/schema/index.js";
import type { TowerProgressRepository } from "./tower.ports.js";

export class DrizzleTowerProgressRepository extends DrizzleRepository implements TowerProgressRepository {
  constructor(database: Database) {
    super(database);
  }

  private where(userId: string, regionId: string, seasonKey: string) {
    return and(eq(userTowerProgress.userId, userId), eq(userTowerProgress.regionId, regionId), eq(userTowerProgress.seasonKey, seasonKey));
  }

  async getCleared(userId: string, regionId: string, seasonKey: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ cleared: userTowerProgress.clearedFloors }).from(userTowerProgress)
      .where(this.where(userId, regionId, seasonKey)).limit(1);
    return row?.cleared ?? 0;
  }

  async lockCleared(userId: string, regionId: string, seasonKey: string, session: DbSession): Promise<number> {
    await this.db(session).insert(userTowerProgress).ignore().values({ userId, regionId, seasonKey, clearedFloors: 0 });
    const [row] = await this.db(session).select({ cleared: userTowerProgress.clearedFloors }).from(userTowerProgress)
      .where(this.where(userId, regionId, seasonKey)).limit(1).for("update");
    return row?.cleared ?? 0;
  }

  async setCleared(userId: string, regionId: string, seasonKey: string, floors: number, session: DbSession): Promise<void> {
    await this.db(session).update(userTowerProgress).set({ clearedFloors: floors }).where(this.where(userId, regionId, seasonKey));
  }

  async deleteOtherSeasons(userId: string, keep: Map<string, string>): Promise<void> {
    for (const [regionId, seasonKey] of keep) {
      await this.database.delete(userTowerProgress)
        .where(and(eq(userTowerProgress.userId, userId), eq(userTowerProgress.regionId, regionId), ne(userTowerProgress.seasonKey, seasonKey)));
    }
  }
}
