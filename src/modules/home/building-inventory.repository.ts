import { and, asc, eq, gte, gt, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userBuildingInventory } from "../../infrastructure/database/schema/index.js";
import type { HomeInventoryEntryDto } from "./home.dto.js";
import type { BuildingInventoryRepository } from "./home.ports.js";

/** Drizzle implementation of the building inventory (every query is scoped by `user_id`). */
export class DrizzleBuildingInventoryRepository extends DrizzleRepository implements BuildingInventoryRepository {
  constructor(database: Database) {
    super(database);
  }

  async list(userId: string, session?: DbSession, forUpdate = false): Promise<HomeInventoryEntryDto[]> {
    const query = this.db(session)
      .select({ buildableId: userBuildingInventory.buildableId, count: userBuildingInventory.count })
      .from(userBuildingInventory)
      .where(and(eq(userBuildingInventory.userId, userId), gt(userBuildingInventory.count, 0)))
      .orderBy(asc(userBuildingInventory.buildableId));
    return session && forUpdate ? await query.for("update") : await query;
  }

  async add(userId: string, buildableId: string, count: number, session: DbSession): Promise<void> {
    await this.db(session).insert(userBuildingInventory)
      .values({ userId, buildableId, count })
      .onDuplicateKeyUpdate({ set: { count: sql`${userBuildingInventory.count} + ${count}` } });
  }

  async consume(userId: string, buildableId: string, count: number, session: DbSession): Promise<boolean> {
    const result = await this.db(session).update(userBuildingInventory)
      .set({ count: sql`${userBuildingInventory.count} - ${count}` })
      .where(and(
        eq(userBuildingInventory.userId, userId),
        eq(userBuildingInventory.buildableId, buildableId),
        gte(userBuildingInventory.count, count),
      ));
    return affectedRows(result) > 0;
  }
}
