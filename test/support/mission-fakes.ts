// In-memory `user_mission_progress` (new-player quest tests).

import type { MissionProgressRow, MissionRepository } from "../../src/modules/missions/missions.ports";

export class InMemoryMissionRepository implements MissionRepository {
  rows = new Map<string, MissionProgressRow & { userId: string }>();

  snapshot(): unknown { return structuredClone(this.rows); }
  restore(state: unknown): void { this.rows = state as Map<string, MissionProgressRow & { userId: string }>; }

  private row(userId: string, missionId: string, periodKey: string) {
    const key = `${userId}|${missionId}|${periodKey}`;
    let row = this.rows.get(key);
    if (!row) this.rows.set(key, (row = { userId, missionId, periodKey, progress: 0, claimedAt: null }));
    return row;
  }

  async listProgress(userId: string, periodKeys: string[]) {
    return [...this.rows.values()].filter((row) => row.userId === userId && periodKeys.includes(row.periodKey))
      .map(({ missionId, periodKey, progress, claimedAt }) => ({ missionId, periodKey, progress, claimedAt }));
  }
  async addProgress(userId: string, periodKey: string, missions: Array<{ missionId: string; target: number }>, amount: number) {
    for (const mission of missions) {
      const row = this.row(userId, mission.missionId, periodKey);
      row.progress = Math.min(mission.target, row.progress + amount);
    }
  }
  async raiseProgress(userId: string, periodKey: string, missions: Array<{ missionId: string; target: number }>, value: number) {
    for (const mission of missions) {
      const row = this.row(userId, mission.missionId, periodKey);
      row.progress = Math.max(row.progress, Math.min(mission.target, value));
    }
  }
  async insertOnce(userId: string, missionId: string, periodKey: string) {
    if (this.rows.has(`${userId}|${missionId}|${periodKey}`)) return false;
    this.row(userId, missionId, periodKey);
    return true;
  }
  async lockOrCreate(userId: string, missionId: string, periodKey: string) {
    const { progress, claimedAt } = this.row(userId, missionId, periodKey);
    return { missionId, periodKey, progress, claimedAt };
  }
  async markClaimed(userId: string, missionId: string, periodKey: string, at: Date) {
    this.row(userId, missionId, periodKey).claimedAt = at;
  }
  async deleteDailyBefore(userId: string, beforeDayKey: string) {
    for (const [key, row] of this.rows) {
      if (row.userId === userId && /^\d{4}-\d{2}-\d{2}$/.test(row.periodKey) && row.periodKey < beforeDayKey) this.rows.delete(key);
    }
  }
}
