import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userMissionProgress } from "../../infrastructure/database/schema/index.js";
import type { MissionProgressRow, MissionRepository } from "./missions.ports.js";

const columns = {
  missionId: userMissionProgress.missionId,
  periodKey: userMissionProgress.periodKey,
  progress: userMissionProgress.progress,
  claimedAt: userMissionProgress.claimedAt,
};

/** Daily keys are `YYYY-MM-DD`; achievement rows use `all`, which never sorts before a date. */
const DAY_KEY_PATTERN = "____-__-__";

export class DrizzleMissionRepository extends DrizzleRepository implements MissionRepository {
  constructor(database: Database) {
    super(database);
  }

  async listProgress(userId: string, periodKeys: string[], session?: DbSession): Promise<MissionProgressRow[]> {
    if (periodKeys.length === 0) return [];
    return this.db(session).select(columns).from(userMissionProgress)
      .where(and(eq(userMissionProgress.userId, userId), inArray(userMissionProgress.periodKey, periodKeys)));
  }

  async addProgress(userId: string, periodKey: string, missions: Array<{ missionId: string; target: number }>, amount: number): Promise<void> {
    for (const mission of missions) {
      await this.database.insert(userMissionProgress)
        .values({ userId, missionId: mission.missionId, periodKey, progress: Math.min(mission.target, amount) })
        .onDuplicateKeyUpdate({ set: { progress: sql`least(${mission.target}, ${userMissionProgress.progress} + ${amount})` } });
    }
  }

  async raiseProgress(userId: string, periodKey: string, missions: Array<{ missionId: string; target: number }>, value: number): Promise<void> {
    for (const mission of missions) {
      const capped = Math.min(mission.target, value);
      await this.database.insert(userMissionProgress)
        .values({ userId, missionId: mission.missionId, periodKey, progress: capped })
        .onDuplicateKeyUpdate({ set: { progress: sql`greatest(${userMissionProgress.progress}, ${capped})` } });
    }
  }

  async insertOnce(userId: string, missionId: string, periodKey: string): Promise<boolean> {
    return affectedRows(await this.database.insert(userMissionProgress).ignore().values({ userId, missionId, periodKey, progress: 0 })) > 0;
  }

  async lockOrCreate(userId: string, missionId: string, periodKey: string, session: DbSession): Promise<MissionProgressRow> {
    await this.db(session).insert(userMissionProgress).ignore().values({ userId, missionId, periodKey, progress: 0 });
    const [row] = await this.db(session).select(columns).from(userMissionProgress)
      .where(and(eq(userMissionProgress.userId, userId), eq(userMissionProgress.missionId, missionId), eq(userMissionProgress.periodKey, periodKey)))
      .limit(1).for("update");
    return row;
  }

  async markClaimed(userId: string, missionId: string, periodKey: string, at: Date, session: DbSession): Promise<void> {
    await this.db(session).update(userMissionProgress).set({ claimedAt: at })
      .where(and(eq(userMissionProgress.userId, userId), eq(userMissionProgress.missionId, missionId), eq(userMissionProgress.periodKey, periodKey)));
  }

  async deleteDailyBefore(userId: string, beforeDayKey: string): Promise<void> {
    await this.database.delete(userMissionProgress)
      .where(and(
        eq(userMissionProgress.userId, userId),
        sql`${userMissionProgress.periodKey} like ${DAY_KEY_PATTERN}`,
        lt(userMissionProgress.periodKey, beforeDayKey),
      ));
  }
}
