import { and, desc, eq, gte } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { StageDifficulty } from "../../shared/kernel/types.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { pveBattles } from "../../infrastructure/database/schema/index.js";
import type { NewStageTicket, PveBattleRecord, PveBattleRepository } from "./battle-pve.ports.js";

const columns = {
  id: pveBattles.id,
  userId: pveBattles.userId,
  regionId: pveBattles.regionId,
  stageId: pveBattles.stageId,
  difficulty: pveBattles.difficulty,
  status: pveBattles.status,
  battleId: pveBattles.battleId,
  startedAt: pveBattles.startedAt,
  result: pveBattles.result,
  energySpent: pveBattles.energySpent,
};

/** MariaDB stores JSON as LONGTEXT, so the driver may hand back a string. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class DrizzlePveBattleRepository extends DrizzleRepository implements PveBattleRepository {
  constructor(database: Database) {
    super(database);
  }

  async createTicket(ticket: NewStageTicket, session: DbSession): Promise<void> {
    await this.db(session).insert(pveBattles).values({ ...ticket, status: "TICKET" });
  }

  async hasUsableTicket(
    userId: string,
    stage: { regionId: string; stageId: string; difficulty: StageDifficulty },
    notBefore: Date,
    ticketId: string | null,
  ): Promise<boolean> {
    const conditions = [
      eq(pveBattles.userId, userId),
      eq(pveBattles.status, "TICKET"),
      eq(pveBattles.regionId, stage.regionId),
      eq(pveBattles.stageId, stage.stageId),
      eq(pveBattles.difficulty, stage.difficulty),
      gte(pveBattles.createdAt, notBefore),
    ];
    if (ticketId) conditions.push(eq(pveBattles.id, ticketId));
    const [row] = await this.database.select({ id: pveBattles.id }).from(pveBattles).where(and(...conditions)).limit(1);
    return !!row;
  }

  async consumeTicket(
    userId: string,
    stage: { regionId: string; stageId: string; difficulty: StageDifficulty },
    battleId: string,
    notBefore: Date,
    ticketId: string | null,
    session: DbSession,
  ): Promise<PveBattleRecord | null> {
    const db = this.db(session);
    const conditions = [
      eq(pveBattles.userId, userId),
      eq(pveBattles.status, "TICKET"),
      eq(pveBattles.regionId, stage.regionId),
      eq(pveBattles.stageId, stage.stageId),
      eq(pveBattles.difficulty, stage.difficulty),
      gte(pveBattles.createdAt, notBefore),
    ];
    if (ticketId) conditions.push(eq(pveBattles.id, ticketId));

    const [row] = await db.select(columns).from(pveBattles).where(and(...conditions))
      .orderBy(desc(pveBattles.createdAt)).limit(1).for("update");
    if (!row) return null;

    const startedAt = new Date();
    await db.update(pveBattles).set({ status: "STARTED", battleId, startedAt }).where(and(eq(pveBattles.id, row.id), eq(pveBattles.userId, userId)));
    return { ...row, status: "STARTED", battleId, startedAt };
  }

  async lockByBattleId(userId: string, battleId: string, session: DbSession): Promise<PveBattleRecord | null> {
    const [row] = await this.db(session).select(columns).from(pveBattles)
      .where(and(eq(pveBattles.battleId, battleId), eq(pveBattles.userId, userId))).limit(1).for("update");
    return row ? { ...row, result: parseJson(row.result) } : null;
  }

  async finish(id: string, status: "VICTORY" | "DEFEAT", result: unknown, session: DbSession): Promise<void> {
    await this.db(session).update(pveBattles).set({ status, result, finishedAt: new Date() }).where(eq(pveBattles.id, id));
  }
}
