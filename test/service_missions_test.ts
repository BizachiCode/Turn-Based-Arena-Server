import assert from "node:assert/strict";

import { MissionConfigSchema, parseMissionConfig, type MissionsConfig } from "../src/config/MissionCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { PlayerActivityHub } from "../src/shared/kernel/activity";
import { noAudit } from "../src/shared/kernel/audit";
import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import type { MissionProgressRow, MissionRepository } from "../src/modules/missions/missions.ports";
import { ACHIEVEMENT_PERIOD, MissionService } from "../src/modules/missions/missions.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import { InMemoryUnitOfWork } from "./support/fakes";
import { rewardKit } from "./support/reward-kit";

// Monday 2026-10-12 10:00 UTC.
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const DAY = 86_400_000;
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
const gold = (amount: number) => ({ currencies: [{ currencyId: "GO", amount }], characters: [], constructions: [], scrolls: [], runes: [] });

class InMemoryMissionRepository implements MissionRepository {
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

function setup(overrides: Partial<MissionsConfig> = {}) {
  const clock = new FixedClock(NOW);
  const repo = new InMemoryMissionRepository();
  const { wallets, ledger, rewards } = rewardKit(clock);
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const config: MissionsConfig = MissionConfigSchema.parse({
    resetHourUtc: 0,
    daily: [
      { id: "d_login", kind: "login", target: 1, rewards: gold(100) },
      { id: "d_stages", kind: "stage_clear", target: 3, rewards: gold(300) },
    ],
    dailyBonus: gold(1000),
    achievements: [
      { id: "a_level_5", kind: "account_level", target: 5, rewards: gold(500) },
      { id: "a_summon_10", kind: "summon", target: 10, rewards: gold(700) },
    ],
    ...overrides,
  });
  const levels = new Map<string, number>();
  const service = new MissionService({
    missions: repo, rewards, ledger,
    rosterCache: new RosterCache(noCache), runeCache: new RuneCache(noCache),
    audit: noAudit, uow, clock, config: () => config,
    accountLevel: async (userId) => levels.get(userId) ?? 1,
  });
  const hub = new PlayerActivityHub();
  hub.subscribe(service);
  return { clock, repo, wallets, service, hub, levels };
}

describe("Missions config", () => {
  it("accepts enum ordinals and rejects duplicate ids", () => {
    const parsed = parseMissionConfig(JSON.stringify({ Daily: [{ Id: "x", Kind: 1, Target: 2 }], Achievements: [] }));
    assert.equal(parsed.daily[0].kind, "stage_clear");
    assert.throws(() => parseMissionConfig(JSON.stringify({ daily: [{ id: "x", kind: "login" }], achievements: [{ id: "x", kind: "summon" }] })));
  });
});

describe("Mission service", () => {
  it("counts the day's login once, daily and achievement progress capped at the target", async () => {
    const { hub, service } = setup();
    await hub.record("u1", "stage_clear", 2);
    await hub.record("u1", "stage_clear", 5);
    await hub.record("u1", "summon", 4);
    await service.getState("u1");
    const state = await service.getState("u1");

    const daily = new Map(state.daily.map((mission) => [mission.missionId, mission]));
    assert.equal(daily.get("d_login")?.progress, 1);
    assert.equal(daily.get("d_stages")?.progress, 3);
    assert.equal(state.achievements.find((mission) => mission.missionId === "a_summon_10")?.progress, 4);
    assert.equal(state.dayKey, "2026-10-12");
    assert.equal(state.dailyResetAt, "2026-10-13T00:00:00.000Z");
    assert.equal(state.dailyBonus.claimable, false);
  });

  it("claims missions once, then the daily bonus after every daily mission", async () => {
    const { hub, service, wallets } = setup();
    await service.getState("u1");
    await assert.rejects(service.claim("u1", "d_stages"), isError("MISSION_NOT_COMPLETE"));
    await hub.record("u1", "stage_clear", 3);

    await service.claim("u1", "d_login");
    await assert.rejects(service.claimDailyBonus("u1"), isError("MISSION_NOT_COMPLETE"));
    const afterStages = await service.claim("u1", "d_stages");
    assert.equal(afterStages.dailyBonus.claimable, true);
    assert.deepEqual(afterStages.grants.currencies, [{ currencyId: "GO", amount: 300 }]);
    await assert.rejects(service.claim("u1", "d_stages"), isError("MISSION_CLAIMED"));

    const bonus = await service.claimDailyBonus("u1");
    assert.equal(bonus.dailyBonus.claimed, true);
    await assert.rejects(service.claimDailyBonus("u1"), isError("MISSION_CLAIMED"));
    assert.equal(wallets.amount("u1", "GO"), 1400);
    await assert.rejects(service.claim("u1", "nope"), isError("MISSION_NOT_FOUND"));
  });

  it("resets daily missions on the next game day and keeps achievements", async () => {
    const { hub, service, clock } = setup();
    await hub.record("u1", "stage_clear", 3);
    await hub.record("u1", "summon", 10);
    await service.claim("u1", "a_summon_10");
    clock.set(NOW + DAY);

    const next = await service.getState("u1");
    assert.equal(next.daily.find((mission) => mission.missionId === "d_stages")?.progress, 0);
    assert.equal(next.daily.find((mission) => mission.missionId === "d_login")?.progress, 1);
    assert.equal(next.achievements.find((mission) => mission.missionId === "a_summon_10")?.claimed, true);
  });

  it("reads account_level achievements from the profile and from level-up activity", async () => {
    const { hub, service, levels, repo } = setup();
    levels.set("u1", 7);
    const state = await service.getState("u1");
    assert.equal(state.achievements.find((mission) => mission.missionId === "a_level_5")?.progress, 5);
    await service.claim("u1", "a_level_5");

    await hub.record("u2", "account_level", 6);
    await hub.record("u2", "account_level", 3);
    assert.equal(repo.rows.get(`u2|a_level_5|${ACHIEVEMENT_PERIOD}`)?.progress, 5, "absolute: never lowered");
  });

  it("refuses everything when disabled", async () => {
    const { service } = setup({ enabled: false });
    await assert.rejects(service.getState("u1"), isError("MISSIONS_DISABLED"));
  });
});
