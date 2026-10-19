import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error";
import { FixedClock } from "../src/shared/kernel/clock";
import type { StageDifficulty } from "../src/shared/kernel/types";
import type { BattlePveSessionFactory } from "../src/modules/battle-pve/BattlePveSessionFactory";
import { BattlePveService } from "../src/modules/battle-pve/battle-pve.service";
import type { BattleRewardService } from "../src/modules/battle-pve/battle-rewards.service";
import { BattleStartGuard } from "../src/modules/battle-pve/battle-start-guard";
import { InMemoryPveBattleRepository, InMemoryUnitOfWork } from "./support/fakes";

const USER = "user-1";
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
const STAGE = { regionId: "r1", stageId: "s1", difficulty: "Easy" as StageDifficulty };

describe("BattleStartGuard", () => {
  it("rejects a concurrent start while the first one is in flight, then allows the next one", async () => {
    const guard = new BattleStartGuard();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;

    const first = guard.run(null, async () => { started++; await gate; return "first"; });
    await assert.rejects(guard.run(null, async () => { started++; return "second"; }), isError("BATTLE_IN_PROGRESS"));
    release();
    assert.equal(await first, "first");
    assert.equal(started, 1, "the second start never ran");

    assert.equal(await guard.run(null, async () => "third"), "third");
  });

  it("releases the flag when the start fails", async () => {
    const guard = new BattleStartGuard();
    await assert.rejects(guard.run(null, async () => { throw new AppError("STAGE_NOT_VALIDATED" as never); }), isError("STAGE_NOT_VALIDATED"));
    assert.equal(await guard.run(null, async () => "ok"), "ok");
  });

  it("refuses to start over a session that is not finished, but accepts a finished one", async () => {
    const guard = new BattleStartGuard();
    await assert.rejects(guard.run({ finished: false }, async () => "x"), isError("BATTLE_IN_PROGRESS"));
    assert.equal(await guard.run({ finished: true }, async () => "x"), "x");
  });
});

describe("BattlePveService.startBattle ticket pre-check", () => {
  function setup() {
    const battles = new InMemoryPveBattleRepository();
    // The shared fake predates the pre-check port: same filter as consumeTicket, read only.
    (battles as unknown as { hasUsableTicket: unknown }).hasUsableTicket = async (userId: string, stage: typeof STAGE, notBefore: Date, ticketId: string | null) =>
      battles.rows.some((row) => row.userId === userId && row.status === "TICKET" && row.regionId === stage.regionId && row.stageId === stage.stageId
        && row.difficulty === stage.difficulty && row.createdAt >= notBefore && (!ticketId || row.id === ticketId));
    let built = 0;
    const sessions = {
      create: async () => { built++; return { battleId: `B${built}`, start() { return {}; } }; },
    } as unknown as BattlePveSessionFactory;
    const service = new BattlePveService(sessions, battles, {} as BattleRewardService, new InMemoryUnitOfWork().register(battles), new FixedClock(Date.now()), () => 30);
    return { battles, service, built: () => built };
  }
  const input = { ...STAGE, uidsInSlots: ["u1"], leaderSlotIndex: 0, requestId: "r" };

  it("does not build a session for a player without a ticket", async () => {
    const { service, built } = setup();
    for (let i = 0; i < 3; i++) await assert.rejects(service.startBattle(USER, input), isError("STAGE_NOT_VALIDATED"));
    assert.equal(built(), 0);
  });

  it("builds the session and consumes the ticket once when one exists", async () => {
    const { service, battles, built } = setup();
    await battles.createTicket({ id: "T1", userId: USER, ...STAGE, currencyId: "energy", energySpent: 3 });

    const adapter = await service.startBattle(USER, input);
    assert.equal(adapter.battleId, "B1");
    assert.equal(built(), 1);
    assert.equal(battles.rows[0].status, "STARTED");

    await assert.rejects(service.startBattle(USER, input), isError("STAGE_NOT_VALIDATED"));
    assert.equal(built(), 1, "the ticket is gone: no further session is built");
  });
});
