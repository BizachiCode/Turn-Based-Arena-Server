import { eq } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userAttendance } from "../../infrastructure/database/schema/index.js";
import type { AttendanceRepository, AttendanceRow } from "./attendance.service.js";

const columns = { claimedDays: userAttendance.claimedDays, lastClaimDay: userAttendance.lastClaimDay };

export class DrizzleAttendanceRepository extends DrizzleRepository implements AttendanceRepository {
  constructor(database: Database) {
    super(database);
  }

  async find(userId: string, session?: DbSession): Promise<AttendanceRow | null> {
    const [row] = await this.db(session).select(columns).from(userAttendance).where(eq(userAttendance.userId, userId)).limit(1);
    return row ?? null;
  }

  async lockOrCreate(userId: string, session: DbSession): Promise<AttendanceRow> {
    await this.db(session).insert(userAttendance).ignore().values({ userId, claimedDays: 0 });
    const [row] = await this.db(session).select(columns).from(userAttendance).where(eq(userAttendance.userId, userId)).limit(1).for("update");
    return row;
  }

  async update(userId: string, row: AttendanceRow, session: DbSession): Promise<void> {
    await this.db(session).update(userAttendance).set({ claimedDays: row.claimedDays, lastClaimDay: row.lastClaimDay }).where(eq(userAttendance.userId, userId));
  }
}
