import { and, desc, eq, inArray, lt, or } from "drizzle-orm";

import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { friendlyMatches } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { FriendlyMatchPatch, FriendlyMatchRecord, FriendlyMatchRepository, FriendlyMatchStatus } from "./friendly.ports.js";

const columns = {
  id: friendlyMatches.id,
  challengerId: friendlyMatches.challengerId,
  targetId: friendlyMatches.targetId,
  status: friendlyMatches.status,
  roomId: friendlyMatches.roomId,
  winnerId: friendlyMatches.winnerId,
  finishedReason: friendlyMatches.finishedReason,
  createdAt: friendlyMatches.createdAt,
  expiresAt: friendlyMatches.expiresAt,
  respondedAt: friendlyMatches.respondedAt,
  finishedAt: friendlyMatches.finishedAt,
};

export class DrizzleFriendlyMatchRepository extends DrizzleRepository implements FriendlyMatchRepository {
  constructor(database: Database) {
    super(database);
  }

  async insert(record: FriendlyMatchRecord, session: DbSession): Promise<void> {
    await this.db(session).insert(friendlyMatches).values({ ...record });
  }

  async findById(id: string, session?: DbSession, forUpdate = false): Promise<FriendlyMatchRecord | null> {
    const query = this.db(session).select(columns).from(friendlyMatches).where(eq(friendlyMatches.id, id)).limit(1);
    const [row] = await (forUpdate ? query.for("update") : query);
    return row ?? null;
  }

  async listOpen(userId: string): Promise<FriendlyMatchRecord[]> {
    return this.database.select(columns).from(friendlyMatches)
      .where(and(
        or(eq(friendlyMatches.challengerId, userId), eq(friendlyMatches.targetId, userId)),
        inArray(friendlyMatches.status, ["pending", "accepted"]),
      ))
      .orderBy(desc(friendlyMatches.createdAt))
      .limit(20);
  }

  async pendingFrom(challengerId: string, session?: DbSession): Promise<FriendlyMatchRecord[]> {
    return this.db(session).select(columns).from(friendlyMatches)
      .where(and(eq(friendlyMatches.challengerId, challengerId), eq(friendlyMatches.status, "pending")));
  }

  async pendingBetween(a: string, b: string, session?: DbSession): Promise<FriendlyMatchRecord[]> {
    return this.db(session).select(columns).from(friendlyMatches)
      .where(and(
        eq(friendlyMatches.status, "pending"),
        or(
          and(eq(friendlyMatches.challengerId, a), eq(friendlyMatches.targetId, b)),
          and(eq(friendlyMatches.challengerId, b), eq(friendlyMatches.targetId, a)),
        ),
      ));
  }

  async expireStale(userIds: readonly string[], now: Date): Promise<void> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    await this.database.update(friendlyMatches).set({ status: "expired" })
      .where(and(
        eq(friendlyMatches.status, "pending"),
        lt(friendlyMatches.expiresAt, now),
        or(inArray(friendlyMatches.challengerId, ids), inArray(friendlyMatches.targetId, ids)),
      ));
  }

  async transition(id: string, from: readonly FriendlyMatchStatus[], to: FriendlyMatchStatus, patch: FriendlyMatchPatch, session?: DbSession): Promise<boolean> {
    const { result, ...fields } = patch;
    const updated = await this.db(session).update(friendlyMatches)
      .set({ status: to, ...fields, ...(result !== undefined ? { resultJson: result } : {}) })
      .where(and(eq(friendlyMatches.id, id), inArray(friendlyMatches.status, [...from])));
    return affectedRows(updated) > 0;
  }
}
