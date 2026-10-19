// Guild quests: personal daily quests of every member (counted from the player's activity) and weekly guild chests.
//
// - Progress is recorded per player only while the player is in a guild (`onActivity`, after the gameplay commit).
// - Claiming a daily quest grants its rewards and adds its `guildPoints` to the player's current guild week.
// - Each member may claim every chest once per week when the guild's week points reach the chest's threshold.
//   Claims are keyed by player + week (not guild), so changing guilds never allows a second claim.

import type { GuildConfig, GuildQuestConfig, GuildQuestKind } from "../../config/GuildCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { PlayerActivityKind, PlayerActivityListener } from "../../shared/kernel/activity.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { RewardGranter } from "../rewards/reward-granter.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";
import { dayKey, nextDailyReset, nextWeeklyReset, QUEST_PROGRESS_RETENTION_DAYS, weekKey } from "./guild-quest.domain.js";
import type { GuildQuestRepository } from "./guild-quest.ports.js";
import type { GuildQuestClaimDto, GuildQuestStateDto } from "./guild.dto.js";
import type { GuildRepository } from "./guild.ports.js";

/** Contributors listed by `guild/quests`. */
const CONTRIBUTOR_LIST_SIZE = 10;
const DAY_MS = 86_400_000;

export type GuildQuestServiceDeps = {
  quests: GuildQuestRepository;
  guilds: GuildRepository;
  rewards: RewardGranter;
  ledger: WalletLedger;
  rosterCache: RosterCache;
  runeCache: RuneCache;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
  config: () => GuildConfig;
};

export class GuildQuestService implements PlayerActivityListener {
  constructor(private readonly deps: GuildQuestServiceDeps) {}

  private get cfg(): GuildQuestConfig {
    return this.deps.config().quests;
  }

  private periods(now = this.deps.clock.now()) {
    const cfg = this.cfg;
    return {
      now,
      day: dayKey(now, cfg.resetHourUtc),
      week: weekKey(now, cfg.resetHourUtc, cfg.weekStartsOn),
    };
  }

  /** Activity listener: counts the action towards the player's daily quests of that kind (members only). */
  async onActivity(userId: string, kind: PlayerActivityKind, amount: number): Promise<void> {
    const cfg = this.cfg;
    if (!cfg.enabled) return;
    const quests = cfg.daily.filter((quest) => quest.kind === (kind as GuildQuestKind));
    if (quests.length === 0) return;
    if (!(await this.deps.guilds.findMembership(userId))) return;

    const { day } = this.periods();
    await this.deps.quests.addProgress(userId, day, quests.map((quest) => ({ questId: quest.id, target: quest.target })), amount);
  }

  /** Daily quests, guild week points, chests and top contributors of the player's guild. */
  async getState(userId: string): Promise<GuildQuestStateDto> {
    const membership = await this.requireMember(userId);
    const { now, day, week } = this.periods();
    const cfg = this.cfg;

    const progress = new Map((await this.deps.quests.listProgress(userId, day)).map((row) => [row.questId, row]));
    const guildPoints = await this.deps.quests.guildPoints(membership.guildId, week);
    const claims = await this.deps.quests.listChestClaims(userId, week);
    const contributors = await this.deps.quests.contributors(membership.guildId, week, CONTRIBUTOR_LIST_SIZE);
    const mine = contributors.find((row) => row.userId === userId)?.points
      ?? await this.deps.quests.memberPoints(membership.guildId, week, userId);

    return {
      ok: true,
      serverTime: now.toISOString(),
      dayKey: day,
      weekKey: week,
      dailyResetAt: nextDailyReset(now, cfg.resetHourUtc).toISOString(),
      weeklyResetAt: nextWeeklyReset(now, cfg.resetHourUtc, cfg.weekStartsOn).toISOString(),
      quests: cfg.daily.map((quest) => {
        const row = progress.get(quest.id);
        return {
          questId: quest.id,
          kind: quest.kind,
          target: quest.target,
          progress: Math.min(quest.target, row?.progress ?? 0),
          claimed: !!row?.claimedAt,
          guildPoints: quest.guildPoints,
          rewards: quest.rewards,
        };
      }),
      guildPoints,
      myPoints: mine,
      chests: cfg.chests.map((chest) => ({
        chestId: chest.id,
        points: chest.points,
        rewards: chest.rewards,
        unlocked: guildPoints >= chest.points,
        claimed: claims.has(chest.id),
      })),
      contributors: contributors.map((row) => ({ name: row.name, level: row.level, iconId: row.iconId, points: row.points, self: row.userId === userId })),
    };
  }

  /** Claims a completed daily quest: grants its rewards and adds its points to the guild week. */
  async claimQuest(userId: string, questId: string): Promise<GuildQuestClaimDto> {
    const quest = this.cfg.daily.find((entry) => entry.id === questId);
    if (!quest) throw new AppError(ErrorCode.GUILD_QUEST_NOT_FOUND);
    const membership = await this.requireMember(userId);
    const { now, day, week } = this.periods();

    const grants = await this.deps.uow.transaction(async (session) => {
      const row = await this.deps.quests.lockProgress(userId, quest.id, day, session);
      if (!row || row.progress < quest.target) throw new AppError(ErrorCode.GUILD_QUEST_NOT_COMPLETE);
      if (row.claimedAt) throw new AppError(ErrorCode.GUILD_QUEST_CLAIMED);

      const granted = await this.deps.rewards.grant(session, userId, quest.rewards, { runeOrigin: "guild_quest" });
      await this.deps.quests.markQuestClaimed(userId, quest.id, day, now, session);
      await this.deps.quests.addActivity(membership.guildId, week, userId, quest.guildPoints, session);
      await this.deps.audit.record({
        userId,
        kind: "GUILD_QUEST_CLAIM",
        meta: { questId: quest.id, day, guildId: membership.guildId, points: quest.guildPoints, currencies: granted.currencies },
      }, session);
      return granted;
    });

    await this.deps.quests.deleteProgressBefore(userId, dayKey(new Date(now.getTime() - QUEST_PROGRESS_RETENTION_DAYS * DAY_MS), this.cfg.resetHourUtc));
    return this.claimResponse(userId, grants);
  }

  /** Claims a weekly chest unlocked by the guild's week points (once per player per week). */
  async claimChest(userId: string, chestId: string): Promise<GuildQuestClaimDto> {
    const chest = this.cfg.chests.find((entry) => entry.id === chestId);
    if (!chest) throw new AppError(ErrorCode.GUILD_QUEST_NOT_FOUND);
    const membership = await this.requireMember(userId);
    const { week } = this.periods();

    const grants = await this.deps.uow.transaction(async (session) => {
      if ((await this.deps.quests.guildPoints(membership.guildId, week, session)) < chest.points) {
        throw new AppError(ErrorCode.GUILD_CHEST_LOCKED, { fields: { points: chest.points } });
      }
      try {
        await this.deps.quests.insertChestClaim(userId, week, chest.id, membership.guildId, session);
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new AppError(ErrorCode.GUILD_CHEST_CLAIMED);
        throw error;
      }
      const granted = await this.deps.rewards.grant(session, userId, chest.rewards, { runeOrigin: "guild_chest" });
      await this.deps.audit.record({
        userId,
        kind: "GUILD_CHEST_CLAIM",
        meta: { chestId: chest.id, week, guildId: membership.guildId, currencies: granted.currencies },
      }, session);
      return granted;
    });

    return this.claimResponse(userId, grants);
  }

  private async requireMember(userId: string) {
    if (!this.cfg.enabled) throw new AppError(ErrorCode.GUILD_QUESTS_DISABLED);
    const membership = await this.deps.guilds.findMembership(userId);
    if (!membership) throw new AppError(ErrorCode.GUILD_NOT_MEMBER);
    return membership;
  }

  private async claimResponse(userId: string, grants: ShopGrantsDto): Promise<GuildQuestClaimDto> {
    if (grants.characters.length > 0) await this.deps.rosterCache.invalidate(userId);
    if (grants.runes.length > 0) await this.deps.runeCache.invalidate(userId);
    return { ...(await this.getState(userId)), grants, wallet: await this.deps.ledger.snapshot(userId) };
  }
}
