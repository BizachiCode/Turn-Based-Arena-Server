// Daily missions and achievements, counted from the player's activity.
//
// - Progress is recorded after each gameplay commit (`onActivity`): daily missions per game day, achievements once per
//   account. `account_level` is absolute (the level reached) and is also read from the profile, so accounts that were
//   already above an achievement level can claim it.
// - Opening the missions (`getState`) counts the day's login once.
// - Claiming grants the mission rewards in one transaction; the daily bonus unlocks once every daily mission of the
//   day was claimed.

import { ABSOLUTE_MISSION_KINDS, type MissionConfig, type MissionKind, type MissionsConfig } from "../../config/MissionCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { PlayerActivityKind, PlayerActivityListener } from "../../shared/kernel/activity.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { gameDayKey, nextGameDay } from "../../shared/kernel/daily-reset.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { RewardGranter } from "../rewards/reward-granter.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";
import type { MissionClaimDto, MissionEntryDto, MissionStateDto } from "./missions.dto.js";
import type { MissionProgressRow, MissionRepository } from "./missions.ports.js";

/** Period key of the achievement rows. */
export const ACHIEVEMENT_PERIOD = "all";
/** Row of the daily bonus claim (per game day). */
export const DAILY_BONUS_ID = "__daily_bonus";
/** Once-per-day marker of the login count. */
export const LOGIN_MARKER_ID = "__login";
/** Daily rows older than this are dropped on claim. */
export const MISSION_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

export type MissionServiceDeps = {
  missions: MissionRepository;
  rewards: RewardGranter;
  ledger: WalletLedger;
  rosterCache: RosterCache;
  runeCache: RuneCache;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
  config: () => MissionsConfig;
  /** Current account level (absolute `account_level` progress). */
  accountLevel: (userId: string, session?: DbSession) => Promise<number>;
};

function hasRewards(payload: MissionsConfig["dailyBonus"]): boolean {
  return payload.currencies.length + payload.characters.length + payload.constructions.length + payload.scrolls.length + payload.runes.length > 0;
}

export class MissionService implements PlayerActivityListener {
  constructor(private readonly deps: MissionServiceDeps) {}

  private get cfg(): MissionsConfig {
    return this.deps.config();
  }

  private day(now = this.deps.clock.now()): string {
    return gameDayKey(now, this.cfg.resetHourUtc);
  }

  /** Activity listener: counts the action towards the daily missions and achievements of that kind. */
  async onActivity(userId: string, kind: PlayerActivityKind, amount: number): Promise<void> {
    const cfg = this.cfg;
    if (!cfg.enabled) return;
    await this.count(userId, kind as MissionKind, amount);
  }

  private async count(userId: string, kind: MissionKind, amount: number): Promise<void> {
    const cfg = this.cfg;
    const pick = (list: MissionConfig[]) => list.filter((mission) => mission.kind === kind).map((mission) => ({ missionId: mission.id, target: mission.target }));
    const daily = pick(cfg.daily);
    const achievements = pick(cfg.achievements);
    const write = ABSOLUTE_MISSION_KINDS.has(kind)
      ? this.deps.missions.raiseProgress.bind(this.deps.missions)
      : this.deps.missions.addProgress.bind(this.deps.missions);
    if (daily.length > 0) await write(userId, this.day(), daily, amount);
    if (achievements.length > 0) await write(userId, ACHIEVEMENT_PERIOD, achievements, amount);
  }

  async getState(userId: string): Promise<MissionStateDto> {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new AppError(ErrorCode.MISSIONS_DISABLED);
    const now = this.deps.clock.now();
    const day = this.day(now);

    if (await this.deps.missions.insertOnce(userId, LOGIN_MARKER_ID, day)) await this.count(userId, "login", 1);

    const rows = await this.deps.missions.listProgress(userId, [day, ACHIEVEMENT_PERIOD]);
    const level = cfg.achievements.some((mission) => mission.kind === "account_level") || cfg.daily.some((mission) => mission.kind === "account_level")
      ? await this.deps.accountLevel(userId)
      : 0;
    const find = (missionId: string, period: string) => rows.find((row) => row.missionId === missionId && row.periodKey === period);
    const entry = (mission: MissionConfig, period: string): MissionEntryDto => {
      const row = find(mission.id, period);
      return {
        missionId: mission.id,
        kind: mission.kind,
        target: mission.target,
        progress: Math.min(mission.target, this.effectiveProgress(mission, row, level)),
        claimed: !!row?.claimedAt,
        rewards: mission.rewards,
      };
    };

    const daily = cfg.daily.map((mission) => entry(mission, day));
    const claimedCount = daily.filter((mission) => mission.claimed).length;
    const bonusClaimed = !!find(DAILY_BONUS_ID, day)?.claimedAt;
    return {
      ok: true,
      serverTime: now.toISOString(),
      dayKey: day,
      dailyResetAt: nextGameDay(now, cfg.resetHourUtc).toISOString(),
      daily,
      dailyBonus: {
        rewards: cfg.dailyBonus,
        claimable: hasRewards(cfg.dailyBonus) && daily.length > 0 && claimedCount === daily.length && !bonusClaimed,
        claimed: bonusClaimed,
        claimedCount,
        total: daily.length,
      },
      achievements: cfg.achievements.map((mission) => entry(mission, ACHIEVEMENT_PERIOD)),
    };
  }

  /** Claims a completed daily mission or achievement. */
  async claim(userId: string, missionId: string): Promise<MissionClaimDto> {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new AppError(ErrorCode.MISSIONS_DISABLED);
    const daily = cfg.daily.find((mission) => mission.id === missionId);
    const mission = daily ?? cfg.achievements.find((entry) => entry.id === missionId);
    if (!mission) throw new AppError(ErrorCode.MISSION_NOT_FOUND);
    const now = this.deps.clock.now();
    const period = daily ? this.day(now) : ACHIEVEMENT_PERIOD;

    const grants = await this.deps.uow.transaction(async (session) => {
      const row = await this.deps.missions.lockOrCreate(userId, mission.id, period, session);
      const level = mission.kind === "account_level" ? await this.deps.accountLevel(userId, session) : 0;
      if (this.effectiveProgress(mission, row, level) < mission.target) throw new AppError(ErrorCode.MISSION_NOT_COMPLETE);
      if (row.claimedAt) throw new AppError(ErrorCode.MISSION_CLAIMED);

      const granted = await this.deps.rewards.grant(session, userId, mission.rewards, { runeOrigin: "mission" });
      await this.deps.missions.markClaimed(userId, mission.id, period, now, session);
      await this.deps.audit.record({ userId, kind: "MISSION_CLAIM", meta: { missionId: mission.id, period, currencies: granted.currencies } }, session);
      return granted;
    });

    if (daily) await this.deps.missions.deleteDailyBefore(userId, gameDayKey(new Date(now.getTime() - MISSION_RETENTION_DAYS * DAY_MS), cfg.resetHourUtc));
    return this.claimResponse(userId, grants);
  }

  /** Claims the daily bonus once every daily mission of the day was claimed. */
  async claimDailyBonus(userId: string): Promise<MissionClaimDto> {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new AppError(ErrorCode.MISSIONS_DISABLED);
    if (cfg.daily.length === 0 || !hasRewards(cfg.dailyBonus)) throw new AppError(ErrorCode.MISSION_NOT_FOUND);
    const now = this.deps.clock.now();
    const day = this.day(now);

    const grants = await this.deps.uow.transaction(async (session) => {
      const bonus = await this.deps.missions.lockOrCreate(userId, DAILY_BONUS_ID, day, session);
      if (bonus.claimedAt) throw new AppError(ErrorCode.MISSION_CLAIMED);
      const rows = await this.deps.missions.listProgress(userId, [day], session);
      const allClaimed = cfg.daily.every((mission) => rows.some((row) => row.missionId === mission.id && !!row.claimedAt));
      if (!allClaimed) throw new AppError(ErrorCode.MISSION_NOT_COMPLETE);

      const granted = await this.deps.rewards.grant(session, userId, cfg.dailyBonus, { runeOrigin: "mission" });
      await this.deps.missions.markClaimed(userId, DAILY_BONUS_ID, day, now, session);
      await this.deps.audit.record({ userId, kind: "MISSION_BONUS_CLAIM", meta: { day, currencies: granted.currencies } }, session);
      return granted;
    });

    return this.claimResponse(userId, grants);
  }

  /** Stored progress, or the account level for `account_level` missions (whichever is higher). */
  private effectiveProgress(mission: MissionConfig, row: MissionProgressRow | undefined, level: number): number {
    const stored = row?.progress ?? 0;
    return mission.kind === "account_level" ? Math.max(stored, level) : stored;
  }

  private async claimResponse(userId: string, grants: ShopGrantsDto): Promise<MissionClaimDto> {
    if (grants.characters.length > 0) await this.deps.rosterCache.invalidate(userId);
    if (grants.runes.length > 0) await this.deps.runeCache.invalidate(userId);
    return { ...(await this.getState(userId)), grants, wallet: await this.deps.ledger.snapshot(userId) };
  }
}
