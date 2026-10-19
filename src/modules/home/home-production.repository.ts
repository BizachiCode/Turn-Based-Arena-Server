import { and, eq } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userHomeProduction } from "../../infrastructure/database/schema/index.js";
import type { HomeProductionRow } from "./home.dto.js";
import type { HomeProductionRepository } from "./home.ports.js";

/** Stationed uids as stored in `units_json` (a JSON array, delivered parsed or as text depending on the driver). */
function parseUnits(raw: unknown): string[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((uid): uid is string => typeof uid === "string" && uid.length > 0) : [];
}

export class DrizzleHomeProductionRepository extends DrizzleRepository implements HomeProductionRepository {
  constructor(database: Database) {
    super(database);
  }

  async list(userId: string, session?: DbSession, forUpdate = false): Promise<HomeProductionRow[]> {
    const query = this.db(session).select({
      instanceId: userHomeProduction.instanceId,
      islandId: userHomeProduction.islandId,
      buildableId: userHomeProduction.buildableId,
      sinceUnix: userHomeProduction.sinceUnix,
      unitsJson: userHomeProduction.unitsJson,
    }).from(userHomeProduction).where(eq(userHomeProduction.userId, userId));
    const rows = session && forUpdate ? await query.for("update") : await query;
    return rows.map((row) => ({
      instanceId: row.instanceId,
      islandId: row.islandId,
      buildableId: row.buildableId,
      sinceUnix: Number(row.sinceUnix),
      units: parseUnits(row.unitsJson),
    }));
  }

  async upsert(userId: string, row: HomeProductionRow, session: DbSession): Promise<void> {
    const values = {
      islandId: row.islandId,
      buildableId: row.buildableId,
      sinceUnix: row.sinceUnix,
      unitsJson: row.units,
    };
    await this.db(session).insert(userHomeProduction)
      .values({ userId, instanceId: row.instanceId, ...values })
      .onDuplicateKeyUpdate({ set: values });
  }

  async delete(userId: string, instanceId: string, session: DbSession): Promise<void> {
    await this.db(session).delete(userHomeProduction).where(and(
      eq(userHomeProduction.userId, userId),
      eq(userHomeProduction.instanceId, instanceId),
    ));
  }
}
