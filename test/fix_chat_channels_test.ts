import assert from "node:assert/strict";

import { ChatRoom } from "../src/modules/chat/chat.room";
import type { ChatRulesDto } from "../src/modules/chat/chat.dto";
import { ChatOccupancy } from "../src/modules/chat/chat.occupancy";
import { ChatService, normalizeChannel } from "../src/modules/chat/chat.service";
import { FixedClock } from "../src/shared/kernel/clock";
import { bindRoom } from "../src/shared/rooms/base-room";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room";
import type { AccessAuthenticator } from "../src/shared/security/access-authenticator";
import type { RateLimiter } from "../src/shared/security/rate-limiter";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const RULES: ChatRulesDto = {
  dirInitialPool: 2,
  dirMaxPool: 5,
  dirRecommended: 3,
  msgMin: 1,
  msgMax: 200,
  rateTokensPer10s: 100,
  rateBurst: 100,
  userWindowSec: 10,
  userMaxInWindow: 100,
  dupMuteBaseSec: 5,
};

const IDENTITY = { userId: "u1", username: "alice", deviceId: "d1", accessJti: "j1" };

function makeChat(rules: Partial<ChatRulesDto> = {}) {
  const published: string[] = [];
  const occupancy = new ChatOccupancy();
  const chat = new ChatService(
    { insertMessage: async () => {}, fetchHistory: async () => [] },
    occupancy,
    async () => ({ nickname: "Alice", iconId: null, level: 1 }),
    () => ({ ...RULES, ...rules }),
    new FixedClock(NOW),
  );
  const presence = { publish: (_topic: string, payload: string) => { published.push(payload); }, subscribe() {}, unsubscribe() {} };
  return { chat, occupancy, presence, published };
}

type Handler = (client: any, payload: unknown, context?: unknown) => Promise<any>;

/** A chat room wired like `container.ts` (bindRoom) without a Colyseus server: handlers are captured. */
function makeRoom(chat: ChatService, presence: unknown, options: { queryLimiter?: RateLimiter; create?: Record<string, unknown> } = {}) {
  const Bound: any = bindRoom(ChatRoom, { chat, queryLimiter: options.queryLimiter });
  const room: any = new Bound();
  const handlers = new Map<string, Handler>();
  const metadata: Array<Record<string, unknown>> = [];
  room.presence = presence;
  room.setMetadata = (value: Record<string, unknown>) => { metadata.push(value); };
  room.setPrivate = () => {};
  room.onMessage = (type: string, handler: Handler) => { handlers.set(type, handler); };
  const create = () => room.onCreate({ channel: 1, ...(options.create ?? {}) });
  return { room, handlers, metadata, create };
}

function authenticated(userId = "u1") {
  return { sessionId: `s-${userId}`, auth: { ...IDENTITY, userId, address: null }, userData: {}, ref: { _socket: { remoteAddress: "10.0.0.5" } } };
}

describe("Chat channel hardening", () => {
  before(() => {
    const authenticator = {
      authenticate: async (token?: string | null) => (token === "good" ? { ...IDENTITY } : null),
      isSessionActive: async () => true,
    } as unknown as AccessAuthenticator;
    configureRoomAuthentication(authenticator);
  });

  describe("Channel numbers", () => {
    it("normalizes anything that is not a non-negative integer to channel 0", () => {
      assert.equal(normalizeChannel(3), 3);
      assert.equal(normalizeChannel(0), 0);
      for (const bad of [undefined, null, -1, 1.5, NaN, Infinity, "2", "abc", {}, [], true, Number.MAX_SAFE_INTEGER + 2]) {
        assert.equal(normalizeChannel(bad), 0, String(bad));
      }
    });

    it("matchmaking normalizes the join options so odd values can't create rooms of their own", async () => {
      for (const channel of [undefined, 2.5, "7", -4, null]) {
        const options: any = { channel, accessToken: "good" };
        await ChatRoom.onAuth("", options, { ip: undefined, headers: new Headers() } as any);
        assert.equal(options.channel, 0);
      }
      const keep: any = { channel: 3, accessToken: "good" };
      await ChatRoom.onAuth("", keep, { ip: undefined, headers: new Headers() } as any);
      assert.equal(keep.channel, 3);

      const missing: any = { accessToken: "good" };
      await ChatRoom.onAuth("", missing, { ip: undefined, headers: new Headers() } as any);
      assert.equal(missing.channel, 0);
    });

    it("listOnly requests are anonymous, boolean and always channel 0 (no room per random channel)", async () => {
      const options: any = { listOnly: "yes", channel: 999 };
      const identity = await ChatRoom.onAuth("", options, { ip: undefined, headers: new Headers() } as any);
      assert.ok(identity);
      assert.equal(options.listOnly, true);
      assert.equal(options.channel, 0);
      assert.equal((identity as any).userId, "");
    });

    it("a request without a valid token is still refused", async () => {
      assert.equal(await ChatRoom.onAuth("", { channel: 1 }, { ip: undefined, headers: new Headers() } as any), false);
    });
  });

  describe("Room creation", () => {
    it("refuses channels outside 0..dirMaxPool-1 without creating anything", async () => {
      const { chat, presence, occupancy } = makeChat();
      for (const channel of [5, 6, 1000, 2_000_000_000]) {
        const { create } = makeRoom(chat, presence, { create: { channel } });
        await assert.rejects(create(), /invalid chat channel/);
      }
      assert.deepEqual(occupancy.snapshot(), []);
      assert.deepEqual(chat.getDirectorySnapshot().channels.map((entry) => entry.channel), [0, 1]);
    });

    it("creates rooms for channels inside the pool and treats a non-integer channel as 0", async () => {
      const { chat, presence } = makeChat();
      const edge = makeRoom(chat, presence, { create: { channel: 4 } });
      await edge.create();
      assert.deepEqual(edge.metadata[0], { channel: 4, listOnly: false });

      const odd = makeRoom(chat, presence, { create: { channel: 1.5 } });
      await odd.create();
      assert.deepEqual(odd.metadata[0], { channel: 0, listOnly: false });
    });

    it("creating a room does not register the channel in the directory", async () => {
      const { chat, presence, occupancy } = makeChat();
      await makeRoom(chat, presence, { create: { channel: 3 } }).create();
      assert.deepEqual(occupancy.snapshot(), []);
      assert.equal(chat.getDirectorySnapshot().channels.some((entry) => entry.channel === 3), false);
    });
  });

  describe("Occupancy follows joins", () => {
    it("counts a channel from onJoin, decrements once per client, and forgets it at zero", async () => {
      const { chat, presence, occupancy } = makeChat();
      const { room, create } = makeRoom(chat, presence, { create: { channel: 3 } });
      await create();

      const a = authenticated("a");
      const b = authenticated("b");
      room.onJoin(a);
      room.onJoin(b);
      assert.deepEqual(occupancy.snapshot(), [{ channel: 3, players: 2 }]);

      room.onLeave(a);
      room.onLeave(a); // a second leave of the same client must not count again
      assert.deepEqual(occupancy.snapshot(), [{ channel: 3, players: 1 }]);
      room.onLeave(b);
      assert.deepEqual(occupancy.snapshot(), []);
    });

    it("rejects an anonymous join of a real channel room (listOnly:true read) and never counts it", async () => {
      const { chat, presence, occupancy } = makeChat();
      const { room, create } = makeRoom(chat, presence, { create: { channel: 1 } });
      await create();

      const anonymous = { sessionId: "s-x", auth: { userId: "", username: "", deviceId: "", accessJti: "", address: null }, userData: {} };
      assert.throws(() => room.onJoin(anonymous), /login required/);
      room.onLeave(anonymous); // Colyseus still runs onLeave for a join that threw
      assert.deepEqual(occupancy.snapshot(), []);

      const noAuth = { sessionId: "s-y", userData: {} };
      assert.throws(() => room.onJoin(noAuth), /login required/);
    });

    it("lets anonymous clients into listOnly helper rooms only", async () => {
      const { chat, presence, occupancy } = makeChat();
      const { room, create } = makeRoom(chat, presence, { create: { listOnly: true } });
      await create();
      const anonymous = { sessionId: "s-x", auth: { userId: "" }, userData: {} };
      room.onJoin(anonymous);
      room.onLeave(anonymous);
      assert.deepEqual(occupancy.snapshot(), []);
    });

    it("disposing the room forgets an empty channel but keeps a channel other rooms still use", async () => {
      const { chat, presence, occupancy } = makeChat();
      const first = makeRoom(chat, presence, { create: { channel: 2 } });
      const second = makeRoom(chat, presence, { create: { channel: 2 } });
      await first.create();
      await second.create();
      first.room.onJoin(authenticated("a"));

      second.room.onDispose();
      assert.deepEqual(occupancy.snapshot(), [{ channel: 2, players: 1 }]);

      const leaver = authenticated("b");
      second.room.onJoin(leaver);
      second.room.onLeave(leaver);
      first.room.onDispose();
      assert.deepEqual(occupancy.snapshot(), [{ channel: 2, players: 1 }]);
    });
  });

  describe("Directory snapshot", () => {
    it("lists the default pool and only occupied channels beyond it; abandoned rooms leave no trace", () => {
      const { chat, presence, occupancy } = makeChat();
      assert.deepEqual(chat.getDirectorySnapshot().channels, [{ channel: 0, players: 0 }, { channel: 1, players: 0 }]);

      occupancy.increment(presence, 4);
      assert.deepEqual(chat.getDirectorySnapshot().channels, [
        { channel: 0, players: 0 },
        { channel: 1, players: 0 },
        { channel: 4, players: 1 },
      ]);

      occupancy.decrement(presence, 4);
      assert.deepEqual(chat.getDirectorySnapshot().channels.map((entry) => entry.channel), [0, 1]);
    });

    it("never steers players into an empty channel outside the pool, and grows the pool only when the others are full", () => {
      const { chat, presence, occupancy } = makeChat();
      occupancy.increment(presence, 0);
      assert.equal(chat.getDirectorySnapshot().suggestedChannel, 1); // emptiest default channel

      for (let i = 0; i < 3; i++) occupancy.increment(presence, 1);
      for (let i = 0; i < 2; i++) occupancy.increment(presence, 0); // 0 -> 3, 1 -> 3: both at the recommended size
      const full = chat.getDirectorySnapshot();
      assert.equal(full.suggestedChannel, 2);
      assert.equal(full.currentPool, 3);
      assert.equal(full.maxPool, 5);
      assert.equal(full.channels.some((entry) => entry.channel === 2), false);
    });

    it("never suggests beyond the maximum pool and ignores out-of-range counts", () => {
      const { chat, presence, occupancy } = makeChat({ dirInitialPool: 1, dirMaxPool: 2, dirRecommended: 1 });
      occupancy.increment(presence, 0);
      occupancy.increment(presence, 1);
      occupancy.increment(presence, 9); // can't happen through the room, but must not leak into the snapshot
      const snapshot = chat.getDirectorySnapshot();
      assert.ok(snapshot.suggestedChannel < 2);
      assert.deepEqual(snapshot.channels.map((entry) => entry.channel), [0, 1]);
      assert.equal(snapshot.currentPool, 2);
    });

    it("keeps the joined channel inside the advertised pool", () => {
      const { chat, presence, occupancy } = makeChat();
      occupancy.increment(presence, 3);
      assert.equal(chat.getDirectorySnapshot().currentPool, 4);
    });
  });

  describe("History rate limit", () => {
    it("rate limits history per user", async () => {
      const { chat, presence } = makeChat();
      const seen: string[] = [];
      const limiter: RateLimiter = { allow: (key) => { seen.push(key); return seen.length <= 2; } };
      const { handlers, create } = makeRoom(chat, presence, { queryLimiter: limiter });
      await create();

      const history = handlers.get("history")!;
      const client = authenticated("u7");
      assert.equal((await history(client, {}, { id: 1 })).ok, true);
      assert.equal((await history(client, {}, { id: 2 })).ok, true);
      const blocked = await history(client, {}, { id: 3 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error, "RATE_LIMIT");
      assert.deepEqual(blocked.messages, []);
      assert.deepEqual(seen, ["u7", "u7", "u7"]);
    });

    it("falls back to a built-in bucket when no limiter is injected", async () => {
      const { chat, presence } = makeChat();
      const { handlers, create } = makeRoom(chat, presence);
      await create();
      const history = handlers.get("history")!;
      const client = authenticated("u8");
      let blocked = 0;
      for (let i = 0; i < 80; i++) if ((await history(client, {}, { id: i })).error === "RATE_LIMIT") blocked++;
      assert.ok(blocked >= 15, `expected the burst of 60 to run out, blocked ${blocked}`);
    });
  });
});

describe("Chat per-user state pruning", () => {
  it("drops expired mutes, duplicate counters and rate windows of users who stopped chatting", async () => {
    const clock = new FixedClock(NOW);
    const chat = new ChatService(
      { insertMessage: async () => {}, fetchHistory: async () => [] },
      new ChatOccupancy(),
      async () => ({ nickname: "Alice", iconId: null, level: 1 }),
      () => ({ ...RULES, userMaxInWindow: 3 }),
      clock,
    );

    for (let i = 0; i < 50; i++) {
      await chat.sendMessage({ channel: 0, userId: `spammer-${i}`, ipAddress: `10.0.0.${i}`, message: "same" });
      await chat.sendMessage({ channel: 0, userId: `spammer-${i}`, ipAddress: `10.0.0.${i}`, message: "same" });
    }
    const busy = chat.trackedUsers();
    assert.equal(busy.windows, 50);
    assert.equal(busy.duplicates, 50);

    // Four more identical lines trigger the duplicate mute of one user.
    for (let i = 0; i < 4; i++) await chat.sendMessage({ channel: 0, userId: "muted", ipAddress: "10.9.9.9", message: "spam" });
    assert.ok(chat.muteUntil("muted") > clock.nowUnix());
    assert.ok(chat.trackedUsers().mutes >= 1);

    clock.advance(10 * 60_000);
    await chat.sendMessage({ channel: 0, userId: "fresh", ipAddress: "10.1.1.1", message: "hello" });

    const after = chat.trackedUsers();
    assert.equal(after.mutes, 0);
    assert.equal(after.duplicates, 1);
    assert.equal(after.windows, 1);
    assert.equal(chat.muteUntil("muted"), 0);
  });

  it("keeps active mutes and windows", async () => {
    const clock = new FixedClock(NOW);
    const chat = new ChatService(
      { insertMessage: async () => {}, fetchHistory: async () => [] },
      new ChatOccupancy(),
      async () => ({ nickname: "Alice", iconId: null, level: 1 }),
      () => ({ ...RULES, dupMuteBaseSec: 100 }),
      clock,
    );
    for (let i = 0; i < 4; i++) await chat.sendMessage({ channel: 0, userId: "muted", ipAddress: "10.9.9.9", message: "spam" });
    const until = chat.muteUntil("muted");
    assert.ok(until > clock.nowUnix() + 60);

    clock.advance(61_000); // a prune is due, the mute (hundreds of seconds) is not over
    await chat.sendMessage({ channel: 0, userId: "other", ipAddress: "10.1.1.1", message: "hello" });
    assert.equal(chat.muteUntil("muted"), until);
  });
});
