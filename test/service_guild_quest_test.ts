import assert from "node:assert/strict";

import { GuildConfigSchema, type GuildConfig } from "../src/config/GuildCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { PlayerActivityHub } from "../src/shared/kernel/activity";
import { noAudit } from "../src/shared/kernel/audit";
import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import { dayKey, nextDailyReset, nextWeeklyReset, weekKey } from "../src/modules/guild/guild-quest.domain";
import type { GuildContributorRow, GuildQuestProgressRow, GuildQuestRepository } from "../src/modules/guild/guild-quest.ports";
import { GuildQuestService } from "../src/modules/guild/guild-quest.service";
import type { GuildMemberRecord, GuildRepository } from "../src/modules/guild/guild.ports";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import { duplicateKeyError, InMemoryUnitOfWork } from "./support/fakes";
import { rewardKit } from "./support/reward-kit";

// Sunday 2026-10-11 12:00 UTC (weeks start on Monday 2026-10-05).
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

class InMemoryGuildQuestRepository implements GuildQuestRepository {
  progress = new Map<string, GuildQuestProgressRow & { userId: string; periodKey: string }>();
  activity = new Map<string, { guildId: string; weekKey: string; userId: string; points: number }>();
  claims = new Map<string, string>();
  profiles = new Map<string, { name: string; level: number; iconId: string }>();

  snapshot(): unknown { return structuredClone({ progress: this.progress, activity: this.activity, claims: this.claims }); }
  restore(state: unknown): void { Object.assign(this, state as object); }

  async listProgress(userId: string, periodKey: string) {
    return [...this.progress.values()].filter((row) => row.userId === userId && row.periodKey === periodKey)
      .map(({ questId, progress, claimedAt }) => ({ questId, progress, claimedAt }));
  }
  async addProgress(userId: string, periodKey: string, quests: Array<{ questId: string; target: number }>, amount: number) {
    for (const quest of quests) {
      const key = `${userId}|${quest.questId}|${periodKey}`;
      const row = this.progress.get(key) ?? { userId, periodKey, questId: quest.questId, progress: 0, claimedAt: null };
      row.progress = Math.min(quest.target, row.progress + amount);
      this.progress.set(key, row);
    }
  }
  async lockProgress(userId: string, questId: string, periodKey: string) {
    const row = this.progress.get(`${userId}|${questId}|${periodKey}`);
    return row ? { questId, progress: row.progress, claimedAt: row.claimedAt } : null;
  }
  async markQuestClaimed(userId: string, questId: string, periodKey: string, at: Date) {
    this.progress.get(`${userId}|${questId}|${periodKey}`)!.claimedAt = at;
  }
  async deleteProgressBefore(userId: string, beforePeriodKey: string) {
    for (const [key, row] of this.progress) if (row.userId === userId && row.periodKey < beforePeriodKey) this.progress.delete(key);
  }
  async addActivity(guildId: string, weekKey: string, userId: string, points: number) {
    const key = `${guildId}|${weekKey}|${userId}`;
    const row = this.activity.get(key) ?? { guildId, weekKey, userId, points: 0 };
    row.points += points;
    this.activity.set(key, row);
  }
  async guildPoints(guildId: string, weekKey: string) {
    return [...this.activity.values()].filter((row) => row.guildId === guildId && row.weekKey === weekKey).reduce((sum, row) => sum + row.points, 0);
  }
  async memberPoints(guildId: string, weekKey: string, userId: string) {
    return this.activity.get(`${guildId}|${weekKey}|${userId}`)?.points ?? 0;
  }
  async contributors(guildId: string, weekKey: string, limit: number): Promise<GuildContributorRow[]> {
    return [...this.activity.values()].filter((row) => row.guildId === guildId && row.weekKey === weekKey)
      .sort((a, b) => b.points - a.points).slice(0, limit)
      .map((row) => ({ userId: row.userId, points: row.points, ...(this.profiles.get(row.userId) ?? { name: row.userId, level: 1, iconId: "" }) }));
  }
  async listChestClaims(userId: string, weekKey: string) {
    return new Set([...this.claims.keys()].filter((key) => key.startsWith(`${userId}|${weekKey}|`)).map((key) => key.split("|")[2]));
  }
  async insertChestClaim(userId: string, weekKey: string, chestId: string, guildId: string) {
    const key = `${userId}|${weekKey}|${chestId}`;
    if (this.claims.has(key)) throw duplicateKeyError();
    this.claims.set(key, guildId);
  }
}

function setup(overrides: Partial<GuildConfig["quests"]> = {}) {
  const clock = new FixedClock(NOW);
  const repo = new InMemoryGuildQuestRepository();
  const memberships = new Map<string, string>();
  const guilds = {
    findMembership: async (userId: string): Promise<GuildMemberRecord | null> => {
      const guildId = memberships.get(userId);
      return guildId ? { userId, guildId, publicId: "p", role: "member", joinedAt: new Date(NOW) } : null;
    },
  } as unknown as GuildRepository;
  const { kit, wallets, ledger, rewards } = rewardKit(clock);
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const base = GuildConfigSchema.parse({});
  const config: GuildConfig = { ...base, quests: { ...base.quests, ...overrides } };
  const service = new GuildQuestService({
    quests: repo, guilds, rewards, ledger,
    rosterCache: new RosterCache(noCache), runeCache: new RuneCache(noCache),
    audit: noAudit, uow, clock, config: () => config,
  });
  const hub = new PlayerActivityHub();
  hub.subscribe(service);
  return { clock, repo, memberships, wallets, kit, service, hub, config };
}

describe("Guild quest periods", () => {
  it("keys days and weeks by their start, honouring the reset hour and week start", () => {
    const now = new Date(NOW);
    assert.equal(dayKey(now, 0), "D:2026-10-11");
    assert.equal(dayKey(now, 15), "D:2026-10-10", "before the 15:00 reset it is still the previous day");
    assert.equal(weekKey(now, 0, 1), "W:2026-10-05");
    assert.equal(weekKey(now, 0, 0), "W:2026-10-11", "weeks starting on Sunday");
    assert.equal(weekKey(new Date(Date.UTC(2026, 9, 12, 2)), 3, 1), "W:2026-10-05", "Monday 02:00 before a 03:00 reset");
    assert.equal(nextDailyReset(now, 0).toISOString(), "2026-10-12T00:00:00.000Z");
    assert.equal(nextDailyReset(now, 15).toISOString(), "2026-10-11T15:00:00.000Z");
    assert.equal(nextWeeklyReset(now, 0, 1).toISOString(), "2026-10-12T00:00:00.000Z");
  });
});

describe("Guild quest service", () => {
  it("counts activity of members only, capped at the target", async () => {
    const { hub, memberships, service } = setup();
    await hub.record("solo", "stage_clear", 3);
    memberships.set("u1", "g1");
    await hub.record("u1", "stage_clear", 3);
    await hub.record("u1", "stage_clear", 9);
    await hub.record("u1", "summon", 11);

    await assert.rejects(service.getState("solo"), isError("GUILD_NOT_MEMBER"));
    const state = await service.getState("u1");
    const byId = new Map(state.quests.map((quest) => [quest.questId, quest]));
    assert.equal(byId.get("daily_stage_clear")?.progress, 5);
    assert.equal(byId.get("daily_summon")?.progress, 1);
    assert.equal(byId.get("daily_arena")?.progress, 0);
    assert.equal(state.dayKey, "D:2026-10-11");
    assert.equal(state.weekKey, "W:2026-10-05");
    assert.equal(state.chests.length, 4);
  });

  it("claims completed quests once, granting rewards and guild points", async () => {
    const { hub, memberships, service, wallets, repo } = setup();
    memberships.set("u1", "g1");
    repo.profiles.set("u1", { name: "Alice", level: 10, iconId: "i" });
    await hub.record("u1", "stage_clear", 4);

    await assert.rejects(service.claimQuest("u1", "daily_stage_clear"), isError("GUILD_QUEST_NOT_COMPLETE"));
    await assert.rejects(service.claimQuest("u1", "nope"), isError("GUILD_QUEST_NOT_FOUND"));
    await hub.record("u1", "stage_clear");

    const claimed = await service.claimQuest("u1", "daily_stage_clear");
    assert.deepEqual(claimed.grants.currencies, [{ currencyId: "GO", amount: 5000 }]);
    assert.equal(wallets.amount("u1", "GO"), 5000);
    assert.equal(claimed.guildPoints, 20);
    assert.equal(claimed.myPoints, 20);
    assert.deepEqual(claimed.contributors, [{ name: "Alice", level: 10, iconId: "i", points: 20, self: true }]);
    assert.equal(claimed.quests.find((quest) => quest.questId === "daily_stage_clear")?.claimed, true);
    await assert.rejects(service.claimQuest("u1", "daily_stage_clear"), isError("GUILD_QUEST_CLAIMED"));
  });

  it("resets daily progress on a new day", async () => {
    const { hub, memberships, service, clock } = setup();
    memberships.set("u1", "g1");
    await hub.record("u1", "rune_upgrade", 3);
    clock.set(NOW + DAY);
    const state = await service.getState("u1");
    assert.equal(state.quests.find((quest) => quest.questId === "daily_rune_upgrade")?.progress, 0);
  });

  it("unlocks chests with the guild week points and allows one claim per player per week", async () => {
    const { memberships, service, repo, wallets, clock } = setup({
      chests: [{ id: "chest_a", points: 30, rewards: { ...GuildConfigSchema.parse({}).quests.chests[0].rewards } }],
    });
    memberships.set("u1", "g1");
    memberships.set("u2", "g1");

    await assert.rejects(service.claimChest("u1", "chest_a"), isError("GUILD_CHEST_LOCKED"));
    await repo.addActivity("g1", "W:2026-10-05", "u2", 30);
    const state = await service.getState("u1");
    assert.equal(state.chests[0].unlocked, true);
    assert.equal(state.myPoints, 0);

    const claimed = await service.claimChest("u1", "chest_a");
    assert.equal(claimed.chests[0].claimed, true);
    assert.equal(wallets.amount("u1", "GO"), 10_000);
    await assert.rejects(service.claimChest("u1", "chest_a"), isError("GUILD_CHEST_CLAIMED"));

    // Changing guilds does not allow a second claim in the same week.
    memberships.set("u1", "g2");
    await repo.addActivity("g2", "W:2026-10-05", "x", 99);
    await assert.rejects(service.claimChest("u1", "chest_a"), isError("GUILD_CHEST_CLAIMED"));

    // Next week: locked again until the guild earns points.
    clock.set(NOW + DAY);
    await assert.rejects(service.claimChest("u1", "chest_a"), isError("GUILD_CHEST_LOCKED"));
  });

  it("refuses everything when quests are disabled", async () => {
    const { memberships, service, hub, repo } = setup({ enabled: false });
    memberships.set("u1", "g1");
    await hub.record("u1", "stage_clear", 5);
    assert.equal(repo.progress.size, 0);
    await assert.rejects(service.getState("u1"), isError("GUILD_QUESTS_DISABLED"));
  });
});
