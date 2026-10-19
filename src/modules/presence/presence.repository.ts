import { and, count, eq, gt, isNull, lt } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userSessions } from "../../infrastructure/database/schema/index.js";
import type { PresenceConnection, PresenceRepository } from "./presence.ports.js";

export class DrizzlePresenceRepository extends DrizzleRepository implements PresenceRepository {
  constructor(database: Database) {
    super(database);
  }

  async upsertSession(connection: PresenceConnection): Promise<void> {
    await this.database.insert(userSessions)
      .values({
        sessionId: connection.sessionId,
        userId: connection.userId,
        deviceId: connection.deviceId,
        room: "presence",
        ip: connection.address,
        userAgent: connection.userAgent,
      })
      .onDuplicateKeyUpdate({ set: { lastHeartbeatAt: new Date(), disconnectedAt: null, userAgent: connection.userAgent } });
  }

  async markDisconnected(sessionId: string): Promise<void> {
    await this.database.update(userSessions).set({ disconnectedAt: new Date() }).where(eq(userSessions.sessionId, sessionId));
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.database.update(userSessions).set({ lastHeartbeatAt: new Date() }).where(eq(userSessions.sessionId, sessionId));
  }

  async countOnline(): Promise<number> {
    const [row] = await this.database.select({ value: count() }).from(userSessions)
      .where(and(isNull(userSessions.disconnectedAt), gt(userSessions.lastHeartbeatAt, new Date(Date.now() - 60_000))));
    return Number(row?.value ?? 0);
  }

  async deleteStaleSessions(before: Date, limit: number): Promise<number> {
    return affectedRows(await this.database.delete(userSessions).where(lt(userSessions.lastHeartbeatAt, before)).limit(Math.max(1, limit)));
  }
}
