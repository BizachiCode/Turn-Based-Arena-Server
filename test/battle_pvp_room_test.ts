import assert from "node:assert/strict";
import type { ColyseusTestServer } from "@colyseus/testing";
import type { Room as SdkRoom } from "@colyseus/sdk";

import { BattlePvpRoom } from "../src/modules/battle-pvp/battle-pvp.room";
import { signMatchTicket } from "../src/modules/battle-pvp/pvp-ticket";
import type { PvpTeam } from "../src/modules/battle-pvp/pvp-session.factory";
import type { FriendlyMatchRecord } from "../src/modules/social/friendly.ports";
import type { FriendlyOutcome } from "../src/modules/social/friendly.service";
import { createColyseusActiveBattleRegistry } from "../src/shared/rooms/active-battles";
import { bindRoom } from "../src/shared/rooms/base-room";
import { AppError } from "../src/shared/errors/app-error";
import { pvpTestSession } from "./battle_pvp_session_test";
import { allowAll, bootRooms, delay, dropConnection, tokenOf, waitFor } from "./support/room-test-kit";
import { RecordingNotifier } from "./support/social-fakes";

const SECRET = "test-ticket-secret";

describe("battle_pvp room (real-time friendly battle)", function () {
  this.timeout(30_000);

  let colyseus: ColyseusTestServer;
  const matches = new Map<string, FriendlyMatchRecord>();
  const allEnded: Array<{ matchId: string; outcome: FriendlyOutcome }> = [];
  /** Ends recorded for the matches of the current test (rooms of earlier tests may still be closing). */
  let currentMatches = new Set<string>();
  const ended = { get length() { return list().length; }, get 0() { return list()[0]; } } as unknown as Array<{ matchId: string; outcome: FriendlyOutcome }>;
  function list() { return allEnded.filter((entry) => currentMatches.has(entry.matchId)); }
  const defenses = new Map<string, { uidsInSlots: string[]; leaderSlotIndex: number }>();
  const notifier = new RecordingNotifier();
  const registry = createColyseusActiveBattleRegistry();
  const rules = { joinTimeoutSeconds: 5, prepareSeconds: 5, turnSeconds: 30, absentTurnDelaySeconds: 0, reconnectSeconds: 5, turnLimit: 60 };
  let counter = 0;

  before(async () => {
    colyseus = await bootRooms({
      battle_pvp: bindRoom(BattlePvpRoom, {
        matches: {
          matchForRoom: async (matchId: string) => { const row = matches.get(matchId); return row && row.status === "accepted" ? row : null; },
          matchEnded: async (matchId: string, outcome: FriendlyOutcome) => { allEnded.push({ matchId, outcome }); return true; },
        },
        sessions: {
          validateTeam: async (team: PvpTeam) => { if (team.uidsInSlots.includes("bad")) throw new AppError("UNIT_NOT_OWNED"); },
          create: async () => pvpTestSession(`B${++counter}`),
        },
        defenses: { defenseOf: async (userId: string) => defenses.get(userId) ?? null },
        directory: { findPlayer: async (userId: string) => ({ userId, name: userId.toUpperCase(), iconId: null, level: 10 }) },
        activeBattles: registry,
        notifier,
        rules: () => rules as never,
        limiter: allowAll,
        ticketSecret: SECRET,
      }),
    });
  });

  after(async () => {
    await colyseus.shutdown();
  });

  beforeEach(async () => {
    Object.assign(rules, { joinTimeoutSeconds: 5, prepareSeconds: 5, turnSeconds: 30, absentTurnDelaySeconds: 0, reconnectSeconds: 5 });
    currentMatches = new Set();
    defenses.clear();
    notifier.clear();
    await colyseus.cleanup();
  });

  async function newMatch(challengerId = "p1", targetId = "p2") {
    const id = `M${String(++counter).padStart(25, "0")}`;
    currentMatches.add(id);
    matches.set(id, {
      id, challengerId, targetId, status: "accepted", roomId: null, winnerId: null, finishedReason: null,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), respondedAt: new Date(), finishedAt: null,
    });
    const room = await colyseus.createRoom("battle_pvp", { matchId: id, ticket: signMatchTicket(SECRET, id) });
    return { matchId: id, roomId: room.roomId };
  }

  /** Joins and records every push (`pvp_state`, `battle_frame`, `pvp_aborted`). */
  async function join(roomId: string, userId: string) {
    const room = await colyseus.sdk.joinById(roomId, { accessToken: tokenOf(userId) });
    const pushes: Array<{ type: string; payload: any }> = [];
    for (const type of ["pvp_state", "battle_frame", "pvp_aborted"]) room.onMessage(type, (payload: any) => pushes.push({ type, payload }));
    return { room, pushes, last: (type: string) => [...pushes].reverse().find((entry) => entry.type === type)?.payload };
  }

  type Player = Awaited<ReturnType<typeof join>>;

  async function toBattle(): Promise<{ matchId: string; roomId: string; a: Player; b: Player }> {
    const { matchId, roomId } = await newMatch();
    const a = await join(roomId, "p1");
    const b = await join(roomId, "p2");
    await waitFor(() => a.last("pvp_state")?.phase === "prepare", 4000, 20, "prepare");
    assert.equal((await a.room.request("pvp/team", { uidsInSlots: ["u1", "u2"], leaderSlotIndex: 0 }) as any).ok, true);
    assert.equal((await b.room.request("pvp/team", { uidsInSlots: ["u3"], leaderSlotIndex: 0 }) as any).ok, true);
    await waitFor(() => !!a.last("battle_frame") && !!b.last("battle_frame"), 4000, 20, "first frames");
    return { matchId, roomId, a, b };
  }

  it("plays a full match: lobby -> prepare -> battle frames for both -> surrender result", async () => {
    const { matchId, a, b } = await toBattle();
    const firstA = a.last("battle_frame");
    const firstB = b.last("battle_frame");
    assert.equal(firstA.localSideId, "side_a");
    assert.equal(firstB.localSideId, "side_b");
    assert.equal(firstA.awaitingPlayerInput, true, "a-1 is the fastest unit");
    assert.equal(firstB.awaitingPlayerInput, false);
    assert.equal(firstB.actionOptions, null);
    assert.ok(firstA.turnDeadlineUnix >= Math.floor(Date.now() / 1000) + 25);
    assert.equal((await registry.find("p1"))?.mode, "pvp");

    const wrong: any = await b.room.request("battle_command", { actorId: "b-1", skillId: "strike", targetId: "a-1" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "NOT_YOUR_TURN");

    const played: any = await a.room.request("battle_command", { actorId: "a-1", skillId: "strike", targetId: "b-1" });
    assert.equal(played.ok, true);
    assert.equal(played.seq, 2);
    await waitFor(() => b.last("battle_frame")?.seq === 2);
    assert.equal(b.last("battle_frame").awaitingPlayerInput, true);

    const surrendered: any = await a.room.request("battle_surrender", {});
    assert.equal(surrendered.finished, true);
    assert.deepEqual(surrendered.result, { friendly: true, victory: false, winnerUserId: "p2", reason: "surrender" });
    await waitFor(() => b.last("battle_frame")?.finished === true);
    assert.equal(b.last("battle_frame").result.victory, true);
    await waitFor(() => a.last("pvp_state")?.phase === "finished", 4000, 20, "final state push");
    assert.equal(a.last("pvp_state").result.winnerUserId, "p2");
    await waitFor(() => ended.length === 1);
    assert.deepEqual([ended[0].matchId, ended[0].outcome.status, ended[0].outcome.winnerId], [matchId, "finished", "p2"]);
    await waitFor(async () => (await registry.find("p1")) === null && (await registry.find("p2")) === null);
  });

  it("clients cannot create the room, strangers cannot join it", async () => {
    await assert.rejects(colyseus.sdk.create("battle_pvp", { accessToken: tokenOf("p1"), matchId: "M-forged" }));
    const { roomId } = await newMatch();
    await assert.rejects(colyseus.sdk.joinById(roomId, { accessToken: tokenOf("p3") }));
    await join(roomId, "p1");
    await assert.rejects(colyseus.sdk.joinById(roomId, { accessToken: tokenOf("p1") }), "a second device of the same player");
  });

  it("refuses a team the player does not own and the AI plays a unit whose timer ran out", async () => {
    rules.turnSeconds = 1;
    const { roomId } = await newMatch();
    const a = await join(roomId, "p1");
    const b = await join(roomId, "p2");
    await waitFor(() => a.last("pvp_state")?.phase === "prepare");
    assert.equal((await a.room.request("pvp/team", { uidsInSlots: ["bad"], leaderSlotIndex: 0 }) as any).error, "UNIT_NOT_OWNED");
    await a.room.request("pvp/team", { uidsInSlots: ["u1"], leaderSlotIndex: 0 });
    await b.room.request("pvp/team", { uidsInSlots: ["u2"], leaderSlotIndex: 0 });
    await waitFor(() => a.last("battle_frame")?.seq === 1);
    await waitFor(() => (a.last("battle_frame")?.seq ?? 0) >= 2, 4000);
    assert.equal(b.last("battle_frame").seq >= 2, true, "both got the auto step");
  });

  it("a player who drops and does not come back loses by forfeit; one who comes back resumes", async () => {
    rules.reconnectSeconds = 1;
    const { a, b } = await toBattle();
    const token = b.room.reconnectionToken;
    dropConnection(b.room);
    await waitFor(() => a.last("pvp_state")?.opponent.connected === false, 4000, 20, "drop seen");
    const resumed = await colyseus.sdk.reconnect(token);
    const state: any = await resumed.request("battle_state", {});
    assert.equal(state.ok, true);
    assert.equal(state.snapshot, true);
    assert.equal(state.localSideId, "side_b");
    await waitFor(() => a.last("pvp_state")?.opponent.connected === true, 4000, 20, "reconnect seen");

    dropConnection(resumed as SdkRoom);
    await waitFor(() => a.last("battle_frame")?.finished === true, 5000, 20, "forfeit frame");
    assert.deepEqual(a.last("battle_frame").result, { friendly: true, victory: true, winnerUserId: "p1", reason: "forfeit" });
    await waitFor(() => ended.length === 1, 4000, 20, "ended");
    assert.equal(ended[0].outcome.reason, "forfeit");
  });

  it("aborts when the opponent never joins, and tells the absent player by push", async () => {
    rules.joinTimeoutSeconds = 1;
    const { matchId, roomId } = await newMatch();
    const a = await join(roomId, "p1");
    await waitFor(() => !!a.last("pvp_aborted"), 4000);
    assert.equal(a.last("pvp_aborted").reason, "join_timeout");
    await waitFor(() => ended.length === 1);
    assert.deepEqual([ended[0].matchId, ended[0].outcome.status], [matchId, "aborted"]);
    assert.deepEqual(notifier.kinds("p2"), ["friendly_match_aborted"]);
    await waitFor(async () => (await registry.find("p1")) === null);
  });

  it("prepare timeout: the arena defense stands in, no team at all loses the match", async () => {
    rules.prepareSeconds = 1;
    defenses.set("p1", { uidsInSlots: ["d1"], leaderSlotIndex: 0 });
    const { roomId } = await newMatch();
    const a = await join(roomId, "p1");
    await join(roomId, "p2");
    await waitFor(() => a.last("pvp_state")?.phase === "finished", 4000);
    assert.deepEqual(a.last("pvp_state").result, { friendly: true, victory: true, winnerUserId: "p1", reason: "no_team" });
    await waitFor(() => ended.length === 1);
    assert.equal(ended[0].outcome.winnerId, "p1");
    await delay(50);
  });
});
