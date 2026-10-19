// Daily attendance (check-in) calendar: one claim per game day; each claim grants the next day of the cycle and the
// cycle starts again after its last day. Served by the `missions` room (`attendance/state`, `attendance/claim`).

import type { AttendanceConfig } from "../../config/AttendanceCatalog.js";
import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { gameDayKey, nextGameDay } from "../../shared/kernel/daily-reset.js";
import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { RewardGranter } from "../rewards/reward-granter.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";

export type AttendanceRow = { claimedDays: number; lastClaimDay: string | null };

/** Persistence of the check-ins (`user_attendance`). */
export interface AttendanceRepository {
  find(userId: string, session?: DbSession): Promise<AttendanceRow | null>;
  /** Locks the row, creating it (0 days) when missing. */
  lockOrCreate(userId: string, session: DbSession): Promise<AttendanceRow>;
  update(userId: string, row: AttendanceRow, session: DbSession): Promise<void>;
}

export type AttendanceStateDto = {
  ok: true;
  serverTime: string;
  dayKey: string;
  /** Next check-in day start (ISO). */
  nextResetAt: string;
  cycleLength: number;
  /** Days of the current cycle already claimed. */
  claimedInCycle: number;
  /** Day of the cycle (0-based) claimable today, or claimed today. */
  todayIndex: number;
  canClaim: boolean;
  days: Array<{ day: number; rewards: ShopPackPayload; claimed: boolean }>;
};

export type AttendanceClaimDto = AttendanceStateDto & { claimedDay: number; grants: ShopGrantsDto; wallet: WalletSnapshot };

export type AttendanceServiceDeps = {
  attendance: AttendanceRepository;
  rewards: RewardGranter;
  ledger: WalletLedger;
  rosterCache: RosterCache;
  runeCache: RuneCache;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
  config: () => AttendanceConfig;
};

export class AttendanceService {
  constructor(private readonly deps: AttendanceServiceDeps) {}

  private enabledConfig(): AttendanceConfig {
    const cfg = this.deps.config();
    if (!cfg.enabled || cfg.days.length === 0) throw new AppError(ErrorCode.ATTENDANCE_DISABLED);
    return cfg;
  }

  async getState(userId: string): Promise<AttendanceStateDto> {
    const cfg = this.enabledConfig();
    return this.toState(cfg, (await this.deps.attendance.find(userId)) ?? { claimedDays: 0, lastClaimDay: null });
  }

  /** Claims today's day of the cycle. */
  async claim(userId: string): Promise<AttendanceClaimDto> {
    const cfg = this.enabledConfig();
    const now = this.deps.clock.now();
    const today = gameDayKey(now, cfg.resetHourUtc);

    const { row, index, grants } = await this.deps.uow.transaction(async (session) => {
      const current = await this.deps.attendance.lockOrCreate(userId, session);
      if (current.lastClaimDay === today) throw new AppError(ErrorCode.ATTENDANCE_CLAIMED);
      const dayIndex = current.claimedDays % cfg.days.length;
      const granted = await this.deps.rewards.grant(session, userId, cfg.days[dayIndex].rewards, { runeOrigin: "attendance" });
      const next = { claimedDays: current.claimedDays + 1, lastClaimDay: today };
      await this.deps.attendance.update(userId, next, session);
      await this.deps.audit.record({ userId, kind: "ATTENDANCE_CLAIM", meta: { day: dayIndex + 1, total: next.claimedDays, currencies: granted.currencies } }, session);
      return { row: next, index: dayIndex, grants: granted };
    });

    if (grants.characters.length > 0) await this.deps.rosterCache.invalidate(userId);
    if (grants.runes.length > 0) await this.deps.runeCache.invalidate(userId);
    return { ...this.toState(cfg, row), claimedDay: index + 1, grants, wallet: await this.deps.ledger.snapshot(userId) };
  }

  private toState(cfg: AttendanceConfig, row: AttendanceRow): AttendanceStateDto {
    const now = this.deps.clock.now();
    const today = gameDayKey(now, cfg.resetHourUtc);
    const length = cfg.days.length;
    const claimedToday = row.lastClaimDay === today;
    // After the last day the cycle restarts on the next claim; today's claim stays shown in its own cycle.
    const todayIndex = claimedToday ? (row.claimedDays - 1) % length : row.claimedDays % length;
    const claimedInCycle = claimedToday ? todayIndex + 1 : todayIndex;

    return {
      ok: true,
      serverTime: now.toISOString(),
      dayKey: today,
      nextResetAt: nextGameDay(now, cfg.resetHourUtc).toISOString(),
      cycleLength: length,
      claimedInCycle,
      todayIndex,
      canClaim: !claimedToday,
      days: cfg.days.map((day, index) => ({ day: index + 1, rewards: day.rewards, claimed: index < claimedInCycle })),
    };
  }
}
