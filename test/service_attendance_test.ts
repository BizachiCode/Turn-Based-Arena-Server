import assert from "node:assert/strict";

import { AttendanceConfigSchema, type AttendanceConfig } from "../src/config/AttendanceCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { noAudit } from "../src/shared/kernel/audit";
import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import { AttendanceService, type AttendanceRepository, type AttendanceRow } from "../src/modules/missions/attendance.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import { InMemoryUnitOfWork } from "./support/fakes";
import { rewardKit } from "./support/reward-kit";

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const DAY = 86_400_000;
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
const gold = (amount: number) => ({ currencies: [{ currencyId: "GO", amount }], characters: [], constructions: [], scrolls: [], runes: [] });

class InMemoryAttendance implements AttendanceRepository {
  rows = new Map<string, AttendanceRow>();
  snapshot(): unknown { return structuredClone(this.rows); }
  restore(state: unknown): void { this.rows = state as Map<string, AttendanceRow>; }
  async find(userId: string) { const row = this.rows.get(userId); return row ? { ...row } : null; }
  async lockOrCreate(userId: string) {
    if (!this.rows.has(userId)) this.rows.set(userId, { claimedDays: 0, lastClaimDay: null });
    return { ...this.rows.get(userId)! };
  }
  async update(userId: string, row: AttendanceRow) { this.rows.set(userId, { ...row }); }
}

function setup(overrides: Partial<AttendanceConfig> = {}) {
  const clock = new FixedClock(NOW);
  const repo = new InMemoryAttendance();
  const { wallets, ledger, rewards } = rewardKit(clock);
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const config = AttendanceConfigSchema.parse({ days: [{ rewards: gold(100) }, { rewards: gold(200) }, { rewards: gold(300) }], ...overrides });
  const service = new AttendanceService({
    attendance: repo, rewards, ledger,
    rosterCache: new RosterCache(noCache), runeCache: new RuneCache(noCache),
    audit: noAudit, uow, clock, config: () => config,
  });
  return { clock, wallets, service };
}

describe("Attendance", () => {
  it("claims one day per game day and walks the cycle", async () => {
    const { clock, wallets, service } = setup();
    const fresh = await service.getState("u1");
    assert.deepEqual([fresh.canClaim, fresh.todayIndex, fresh.claimedInCycle, fresh.cycleLength], [true, 0, 0, 3]);

    const first = await service.claim("u1");
    assert.equal(first.claimedDay, 1);
    assert.deepEqual([first.canClaim, first.todayIndex, first.claimedInCycle], [false, 0, 1]);
    assert.deepEqual(first.days.map((day) => day.claimed), [true, false, false]);
    await assert.rejects(service.claim("u1"), isError("ATTENDANCE_CLAIMED"));

    clock.set(NOW + DAY);
    assert.equal((await service.claim("u1")).claimedDay, 2);
    clock.set(NOW + 2 * DAY);
    const third = await service.claim("u1");
    assert.deepEqual([third.claimedDay, third.claimedInCycle], [3, 3]);
    assert.equal(wallets.amount("u1", "GO"), 600);

    clock.set(NOW + 3 * DAY);
    const wrapped = await service.getState("u1");
    assert.deepEqual([wrapped.canClaim, wrapped.todayIndex, wrapped.claimedInCycle], [true, 0, 0], "a new cycle starts after the last day");
    assert.equal((await service.claim("u1")).claimedDay, 1);
  });

  it("skipped days do not break the cycle and the feature can be disabled", async () => {
    const { clock, service } = setup();
    await service.claim("u1");
    clock.set(NOW + 5 * DAY);
    assert.equal((await service.claim("u1")).claimedDay, 2);

    const disabled = setup({ enabled: false }).service;
    await assert.rejects(disabled.getState("u1"), isError("ATTENDANCE_DISABLED"));
  });
});
