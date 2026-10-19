import { eq } from "drizzle-orm";
import type { AccountProgressRepository } from "../progression/account-progression.service.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userProfile } from "../../infrastructure/database/schema/index.js";
import type { ProfileRepository, ProfileRow } from "./profile.ports.js";

/** Drizzle implementation of {@link ProfileRepository}. */
export class DrizzleProfileRepository extends DrizzleRepository implements ProfileRepository, AccountProgressRepository {
  constructor(database: Database) {
    super(database);
  }

  async findByUserId(userId: string, session?: DbSession): Promise<ProfileRow | null> {
    const [row] = await this.db(session)
      .select({ name: userProfile.name, iconId: userProfile.iconId, level: userProfile.level, currentExp: userProfile.currentExp })
      .from(userProfile)
      .where(eq(userProfile.userId, userId))
      .limit(1);
    return row ?? null;
  }

  async isNameTaken(name: string, exceptUserId?: string, session?: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ userId: userProfile.userId }).from(userProfile).where(eq(userProfile.name, name)).limit(1);
    return !!row && row.userId !== exceptUserId;
  }

  async insertProfile(userId: string, profile: ProfileRow, session?: DbSession): Promise<void> {
    await this.db(session).insert(userProfile).values({ userId, ...profile });
  }

  async updateNickname(userId: string, nickname: string, session?: DbSession): Promise<void> {
    await this.db(session).update(userProfile).set({ name: nickname }).where(eq(userProfile.userId, userId));
  }

  async updateIcon(userId: string, iconId: string, session?: DbSession): Promise<void> {
    await this.db(session).update(userProfile).set({ iconId }).where(eq(userProfile.userId, userId));
  }

  async lockProgress(userId: string, session: DbSession): Promise<{ level: number; currentExp: number } | null> {
    const [row] = await this.db(session)
      .select({ level: userProfile.level, currentExp: userProfile.currentExp })
      .from(userProfile)
      .where(eq(userProfile.userId, userId))
      .limit(1)
      .for("update");
    return row ?? null;
  }

  async updateProgress(userId: string, level: number, currentExp: number, session: DbSession): Promise<void> {
    await this.db(session).update(userProfile).set({ level, currentExp }).where(eq(userProfile.userId, userId));
  }
}
