import { and, eq, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userHomeIslands, userHomeObjects, userHomePrefs } from "../../infrastructure/database/schema/index.js";
import type { HomeObjectRow } from "./home.dto.js";
import type { HomeRepository } from "./home.ports.js";

const columns = {
  instanceId: userHomeObjects.instanceId,
  islandId: userHomeObjects.islandId,
  definitionId: userHomeObjects.definitionId,
  templateInstanceId: userHomeObjects.templateInstanceId,
  state: userHomeObjects.state,
  originX: userHomeObjects.originX,
  originZ: userHomeObjects.originZ,
  yawDegrees: userHomeObjects.yawDegrees,
  isTemplateObject: userHomeObjects.isTemplateObject,
};

export class DrizzleHomeRepository extends DrizzleRepository implements HomeRepository {
  constructor(database: Database) {
    super(database);
  }

  async listObjects(userId: string, session?: DbSession, forUpdate = false): Promise<HomeObjectRow[]> {
    const query = this.db(session).select(columns).from(userHomeObjects).where(eq(userHomeObjects.userId, userId));
    const rows = session && forUpdate ? await query.for("update") : await query;
    return rows.map((row) => ({ ...row, isTemplateObject: row.isTemplateObject === 1 }));
  }

  async getPrefs(userId: string, session?: DbSession, forUpdate = false): Promise<{ selectedIslandId: string | null; revision: number }> {
    const query = this.db(session).select({ selectedIslandId: userHomePrefs.selectedIslandId, revision: userHomePrefs.revision })
      .from(userHomePrefs).where(eq(userHomePrefs.userId, userId)).limit(1);
    const [row] = session && forUpdate ? await query.for("update") : await query;
    return { selectedIslandId: row?.selectedIslandId ?? null, revision: row?.revision ?? 0 };
  }

  async commitMutation(userId: string, islandId: string, session: DbSession): Promise<void> {
    await this.db(session).insert(userHomePrefs)
      .values({ userId, selectedIslandId: islandId, revision: 1 })
      .onDuplicateKeyUpdate({ set: { selectedIslandId: islandId, revision: sql`${userHomePrefs.revision} + 1` } });
  }

  async upsertPlayerObject(userId: string, row: Omit<HomeObjectRow, "templateInstanceId" | "state" | "isTemplateObject">, session: DbSession): Promise<void> {
    const values = {
      islandId: row.islandId,
      definitionId: row.definitionId,
      state: "ACTIVE" as const,
      originX: row.originX,
      originZ: row.originZ,
      yawDegrees: row.yawDegrees,
      isTemplateObject: 0,
    };
    await this.db(session).insert(userHomeObjects)
      .values({ userId, instanceId: row.instanceId, templateInstanceId: null, ...values })
      .onDuplicateKeyUpdate({ set: values });
  }

  async upsertTemplateState(userId: string, row: HomeObjectRow, session: DbSession): Promise<void> {
    const values = {
      definitionId: row.definitionId,
      state: row.state,
      originX: row.originX,
      originZ: row.originZ,
      yawDegrees: row.yawDegrees,
      isTemplateObject: 1,
    };
    await this.db(session).insert(userHomeObjects)
      .values({ userId, instanceId: row.instanceId, islandId: row.islandId, templateInstanceId: row.templateInstanceId, ...values })
      .onDuplicateKeyUpdate({ set: values });
  }

  async listUnlockedIslands(userId: string, session?: DbSession, forUpdate = false): Promise<string[]> {
    const query = this.db(session).select({ islandId: userHomeIslands.islandId }).from(userHomeIslands)
      .where(eq(userHomeIslands.userId, userId));
    const rows = session && forUpdate ? await query.for("update") : await query;
    return rows.map((row) => row.islandId);
  }

  async unlockIsland(userId: string, islandId: string, session: DbSession): Promise<boolean> {
    return affectedRows(await this.db(session).insert(userHomeIslands).ignore().values({ userId, islandId })) > 0;
  }

  async deletePlayerObject(userId: string, instanceId: string, session: DbSession): Promise<void> {
    await this.db(session).delete(userHomeObjects).where(and(
      eq(userHomeObjects.userId, userId),
      eq(userHomeObjects.instanceId, instanceId),
      eq(userHomeObjects.isTemplateObject, 0),
    ));
  }
}
