import assert from "node:assert/strict";
import type { ColyseusTestServer } from "@colyseus/testing";

import type { ArenaBattleService } from "../src/modules/arena/arena-battle.service";
import type { BattlePveSessionStepResult } from "../src/modules/battle-pve/BattlePveSession";
import type { BattlePveService } from "../src/modules/battle-pve/battle-pve.service";
import type { BattleSessionPort } from "../src/modules/battle-pve/battle-pve.ports";
import { BattlePveRoom } from "../src/modules/battle-pve/battle-pve.room";
import { BattleSessionAdapter } from "../src/modules/battle-pve/battle-session.adapter";
import { bindRoom } from "../src/shared/rooms/base-room";
import { createColyseusActiveBattleRegistry } from "../src/shared/rooms/active-battles";
import { allowAll, bootRooms, delay, dropConnection, tokenOf, waitFor } from "./support/room-test-kit";

/** Two player commands win the battle; surrender loses it. */
class FakeSession implements BattleSessionPort {
  private commands = 0;
  constructor(readonly battleId: string) {}

  private step(finished: boolean, victory: boolean | null): BattlePveSessionStepResult {
    return {
      accepted: true,
      state: { battleId: this.battleId, units: {}, teams: [], metadata: {} } as never,
      events: [],
      awaitingPlayerInput: !finished,
      activeUnitId: finished ? null : "player-1",
      activeSideId: finished ? null : "players",
      currentWaveIndex: 0,
      totalWaves: 1,
      phase: finished ? "finished" : "awaiting_action",
      turn: this.commands,
      round: 1,
      finished,
      winnerSideId: finished ? (victory ? "players" : "enemies") : null,
      finishedReason: finished ? (victory ? "all_enemies_defeated" : "surrender") : null,
      victory,
      actionOptions: null,
      actorOptions: null,
      turnOrder: { mode: "AttackBar", round: 1, sideId: null, actorIds: [], nextActorIds: [] } as never,
    };
  }

  start() { return this.step(false, null); }
  usePlayerSkill() { this.commands++; return this.commands >= 2 ? this.step(true, true) : this.step(false, null); }
  usePlayerAuto() { return this.usePlayerSkill(); }
  surrender() { return this.step(true, false); }
}

const START = { regionId: "r1", stageId: "s1", difficulty: "Easy", uidsInSlots: ["u1"], leaderSlotIndex: 0, requestId: "req-1" };
const COMMAND = { actorId: "player-1", skillId: "s1", targetId: "enemy-1" };

describe("Battle room: one live battle per player + reconnection", function () {
  this.timeout(20_000);

  let colyseus: ColyseusTestServer;
  let counter = 0;
  let windowSeconds = 5;
  const arenaSettled: Array<{ userId: string; battleId: string; victory: boolean }> = [];
  const registry = createColyseusActiveBattleRegistry();

  const battles = {
    startBattle: async () => new BattleSessionAdapter(new FakeSession(`B${++counter}`)),
    settleIfFinished: async (_userId: string, battleId: string, step: BattlePveSessionStepResult) => (step.finished ? { battleId, victory: step.victory } : null),
  } as unknown as BattlePveService;

  const arena = {
    startBattle: async () => new BattleSessionAdapter(new FakeSession(`A${++counter}`), "arena"),
    settle: async (userId: string, battleId: string, victory: boolean) => {
      arenaSettled.push({ userId, battleId, victory });
      return { victory };
    },
  } as unknown as ArenaBattleService;

  before(async () => {
    colyseus = await bootRooms({
      battle_pve: bindRoom(BattlePveRoom, {
        battles,
        arena,
        limiter: allowAll,
        activeBattles: registry,
        reconnectSeconds: () => windowSeconds,
      }),
    });
  });

  after(async () => {
    await colyseus.shutdown();
  });

  beforeEach(async () => {
    windowSeconds = 5;
    arenaSettled.length = 0;
    await colyseus.cleanup();
  });

  const join = (userId: string) => colyseus.sdk.joinOrCreate("battle_pve", { accessToken: tokenOf(userId) });

  it("refuses a second live battle in another room and frees the slot when the battle ends", async () => {
    const first = await join("p1");
    const second = await join("p1");
    assert.notEqual(first.roomId, second.roomId, "one room per battle");

    const started: any = await first.request("battle_start", START);
    assert.equal(started.ok, true);

    const refused: any = await second.request("battle_start", START);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "BATTLE_IN_PROGRESS");
    assert.equal(refused.activeBattle.roomId, first.roomId);
    assert.equal(refused.activeBattle.battleId, started.battleId);

    await first.request("battle_command", COMMAND);
    const last: any = await first.request("battle_command", COMMAND);
    assert.equal(last.finished, true);
    assert.deepEqual(last.result, { battleId: started.battleId, victory: true });

    await waitFor(async () => (await registry.find("p1")) === null);
    const next: any = await second.request("battle_start", START);
    assert.equal(next.ok, true, JSON.stringify(next));
  });

  it("keeps the seat of a dropped player, who resumes with the reconnection token and battle_state", async () => {
    const room = await join("p2");
    const started: any = await room.request("battle_start", START);
    await room.request("battle_command", COMMAND);

    const token = room.reconnectionToken;
    dropConnection(room);
    await delay(150);
    assert.equal((await registry.find("p2"))?.roomId, room.roomId, "the slot survives the drop");

    const resumed = await colyseus.sdk.reconnect(token);
    assert.equal(resumed.roomId, room.roomId);
    const state: any = await resumed.request("battle_state", {});
    assert.equal(state.ok, true);
    assert.equal(state.snapshot, true);
    assert.equal(state.battleId, started.battleId);
    assert.equal(state.turn, 1, "the last step before the drop");

    const last: any = await resumed.request("battle_command", COMMAND);
    assert.equal(last.finished, true);
  });

  it("an arena battle whose player does not come back in time is settled as a defeat", async () => {
    windowSeconds = 1;
    const room = await join("p3");
    const started: any = await room.request("battle_start_arena", { opponentId: "npc:x", uidsInSlots: ["u1"], leaderSlotIndex: 0, requestId: "a1" });
    assert.equal(started.ok, true, JSON.stringify(started));

    dropConnection(room);
    await waitFor(() => arenaSettled.length > 0, 5000);
    assert.deepEqual(arenaSettled, [{ userId: "p3", battleId: started.battleId, victory: false }]);
    await waitFor(async () => (await registry.find("p3")) === null);
  });

  it("leaving on purpose gives no reconnection window and frees the slot", async () => {
    const room = await join("p4");
    await room.request("battle_start", START);
    await room.leave(true);
    await waitFor(async () => (await registry.find("p4")) === null);
  });
});
