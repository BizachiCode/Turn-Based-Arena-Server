import assert from "node:assert/strict";

import { GuildConfigSchema } from "../src/config/GuildCatalog";
import type { ChatRulesDto } from "../src/modules/chat/chat.dto";
import { ChatOccupancy } from "../src/modules/chat/chat.occupancy";
import { ChatService } from "../src/modules/chat/chat.service";
import { parseGuildChatEvent, routeGuildChatEvent, type GuildChatConnection } from "../src/modules/chat/guild-chat.fanout";
import type { GuildChatFanoutEvent, GuildChatRepository } from "../src/modules/chat/guild-chat.ports";
import { GuildChatRoom } from "../src/modules/chat/guild-chat.room";
import { GuildChatService, guildChatMembershipOf } from "../src/modules/chat/guild-chat.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { GuildService } from "../src/modules/guild/guild.service";
import { FixedClock } from "../src/shared/kernel/clock";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room";
import { bindRoom } from "../src/shared/rooms/base-room";
import type { AccessAuthenticator } from "../src/shared/security/access-authenticator";
import type { RateLimiter } from "../src/shared/security/rate-limiter";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";
import { InMemoryGuildRepository } from "./support/guild-fakes";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const RULES: ChatRulesDto = {
  dirInitialPool: 1,
  dirMaxPool: 5,
  dirRecommended: 50,
  msgMin: 1,
  msgMax: 200,
  rateTokensPer10s: 100,
  rateBurst: 100,
  userWindowSec: 10,
  userMaxInWindow: 100,
  dupMuteBaseSec: 5,
};

class Connection implements GuildChatConnection {
  received: Array<{ type: string; payload: any }> = [];
  constructor(readonly userId: string, public guildId: string | null) {}
  send(type: "guild_chat_msg" | "guild_chat_state", payload: unknown): void { this.received.push({ type, payload }); }
  messages(): any[] { return this.received.filter((entry) => entry.type === "guild_chat_msg").map((entry) => entry.payload); }
}

/** Guild chat history that can be told to fail (the system line of a kick must not decide who keeps access). */
class FlakyHistory implements GuildChatRepository {
  failInserts = false;
  async insertMessage(): Promise<number> {
    if (this.failInserts) throw new Error("db down");
    return 1;
  }
  async fetchHistory() { return []; }
}

function setup() {
  const clock = new FixedClock(NOW);
  const guildRepo = new InMemoryGuildRepository(clock);
  const wallets = new InMemoryWalletRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(guildRepo);
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "GO" }]), clock);
  const config = GuildConfigSchema.parse({});
  const chat = new ChatService(
    { insertMessage: async () => {}, fetchHistory: async () => [] },
    new ChatOccupancy(),
    async (userId) => {
      const profile = guildRepo.profiles.get(userId);
      return profile ? { nickname: profile.name, iconId: profile.iconId, level: profile.level } : null;
    },
    () => RULES,
    clock,
  );

  const history = new FlakyHistory();
  const events: GuildChatFanoutEvent[] = [];
  const connections: Connection[] = [];
  const guildChat = new GuildChatService({
    repo: history,
    membership: guildChatMembershipOf(guildRepo),
    chat,
    clock,
    fanout: {
      publish: (event) => {
        events.push(event);
        const parsed = parseGuildChatEvent(JSON.stringify(event));
        assert.ok(parsed);
        routeGuildChatEvent(parsed, connections, clock.nowUnix());
      },
    },
  });

  let ids = 0;
  const guilds = new GuildService({
    guilds: guildRepo, ledger, uow, clock, config: () => config, events: guildChat,
    newGuildId: () => `g${++ids}`,
    newPublicId: () => `p${(++ids).toString().padStart(3, "0")}`,
  });

  const player = (userId: string) => {
    guildRepo.profiles.set(userId, { name: `Name-${userId}`, level: 10, iconId: "icon_1" });
    wallets.set(userId, "GO", 100_000);
  };
  const connect = async (userId: string) => {
    const connection = new Connection(userId, (await guildChat.access(userId))?.guildId ?? null);
    connections.push(connection);
    return connection;
  };
  return { guildRepo, history, guildChat, guilds, events, connections, player, connect };
}

describe("Guild chat access revocation", () => {
  it("a kicked member loses the guild channel even when the system line cannot be stored", async () => {
    const env = setup();
    ["lead", "member"].forEach(env.player);
    const created = await env.guilds.create("lead", { name: "Alpha", description: "", iconId: "emblem_lion", tags: [], joinType: "open", minLevel: 1 });
    const guildId = created.guild!.guildId;
    await env.guilds.join("member", guildId);
    const live = await env.connect("member");
    assert.equal(live.guildId, guildId);

    env.history.failInserts = true;
    const memberId = (await env.guilds.getState("lead")).members.find((m) => m.name === "Name-member")!.memberId;
    await env.guilds.kick("lead", memberId); // GuildService logs and swallows the listener failure

    assert.equal(live.guildId, null, "access must be revoked although posting the system line failed");
    assert.equal(live.received.at(-1)?.type, "guild_chat_state");
    assert.equal(live.received.at(-1)?.payload.inGuild, false);
  });

  it("guildChanged still throws the line failure after revoking (the caller logs it)", async () => {
    const env = setup();
    env.player("lead");
    await env.guilds.create("lead", { name: "Alpha", description: "", iconId: "emblem_lion", tags: [], joinType: "open", minLevel: 1 });
    env.history.failInserts = true;
    await assert.rejects(env.guildChat.guildChanged({ kind: "kicked", guildId: "g1", userId: "ghost" }), /db down/);
    assert.deepEqual(env.events.at(-1), { type: "membership", userId: "ghost", guildId: null, guildName: null });
  });

  it("revokes access when the membership lookup itself fails for a leaving member", async () => {
    const env = setup();
    const published: GuildChatFanoutEvent[] = [];
    const guildChat = new GuildChatService({
      repo: env.history,
      membership: { guildOf: async () => { throw new Error("db down"); } },
      chat: new ChatService({ insertMessage: async () => {}, fetchHistory: async () => [] }, new ChatOccupancy(), async () => null, () => RULES, new FixedClock(NOW)),
      clock: new FixedClock(NOW),
      fanout: { publish: (event) => { published.push(event); } },
    });
    await guildChat.guildChanged({ kind: "left", guildId: "g1", userId: "u1", disbanded: true });
    assert.deepEqual(published, [{ type: "membership", userId: "u1", guildId: null, guildName: null }]);

    // Entering is the opposite: no access may be granted from a failed lookup.
    published.length = 0;
    await assert.rejects(guildChat.guildChanged({ kind: "joined", guildId: "g1", userId: "u1" }), /db down/);
    assert.deepEqual(published, []);
  });

  it("a GM disband tells every member's live connections that the guild is gone", async () => {
    const env = setup();
    ["lead", "m1", "m2", "outsider"].forEach(env.player);
    const created = await env.guilds.create("lead", { name: "Alpha", description: "", iconId: "emblem_lion", tags: [], joinType: "open", minLevel: 1 });
    const guildId = created.guild!.guildId;
    await env.guilds.join("m1", guildId);
    await env.guilds.join("m2", guildId);
    const live = await Promise.all(["lead", "m1", "m2", "outsider"].map(env.connect));
    const before = env.events.length;

    assert.deepEqual(await env.guilds.operatorDisband(guildId), { members: 3 });

    const revoked = env.events.slice(before).filter((event) => event.type === "membership").map((event) => (event as any).userId).sort();
    assert.deepEqual(revoked, ["lead", "m1", "m2"]);
    assert.deepEqual(live.map((connection) => connection.guildId), [null, null, null, null]);
    for (const connection of live.slice(0, 3)) assert.equal(connection.received.at(-1)?.payload.inGuild, false);
    assert.equal(live[3].received.length, 0);
    assert.equal(env.events.slice(before).some((event) => event.type === "message"), false, "a disbanded guild gets no system line");
  });

  it("a GM removal of the last member (guild disbanded) also drops the stale guild", async () => {
    const env = setup();
    env.player("solo");
    const created = await env.guilds.create("solo", { name: "Solo", description: "", iconId: "emblem_lion", tags: [], joinType: "open", minLevel: 1 });
    const live = await env.connect("solo");
    assert.equal(live.guildId, created.guild!.guildId);

    assert.deepEqual(await env.guilds.operatorRemoveMember("solo"), { guildId: created.guild!.guildId, disbanded: true });
    assert.equal(live.guildId, null);
  });
});

describe("Guild chat room membership races", () => {
  before(() => {
    configureRoomAuthentication({ authenticate: async () => null, isSessionActive: async () => true } as unknown as AccessAuthenticator);
  });

  type Handler = (client: any, payload: unknown, context?: unknown) => Promise<any>;

  function makeRoom(guildChat: unknown, options: { sendLimiter?: RateLimiter } = {}) {
    const Bound: any = bindRoom(GuildChatRoom, {
      guildChat: guildChat as GuildChatService,
      queryLimiter: { allow: () => true },
      sendLimiter: options.sendLimiter,
    });
    const room: any = new Bound();
    const handlers = new Map<string, Handler>();
    room.presence = { subscribe() {}, unsubscribe() {}, publish() {} };
    room.setMetadata = () => {};
    room.onMessage = (type: string, handler: Handler) => { handlers.set(type, handler); };
    return { room, handlers };
  }

  function liveClient(userId: string) {
    const sent: Array<{ type: string; payload: any }> = [];
    return {
      sessionId: `s-${userId}`,
      auth: { userId, username: userId, deviceId: "d", accessJti: "j", address: null },
      userData: {} as Record<string, unknown>,
      sent,
      send: (type: string, payload: unknown) => { sent.push({ type, payload }); },
    };
  }

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const kicked: GuildChatFanoutEvent = { type: "membership", userId: "u1", guildId: null, guildName: null };

  it("a kick applied while history is awaiting the database is not overwritten by the older answer", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    const service = {
      getHistory: async () => {
        await gate;
        return { ok: true, guildId: "g1", guildName: "Alpha", messages: [], serverTimeUnix: 1, access: { guildId: "g1", guildName: "Alpha" } };
      },
    };
    const { room, handlers } = makeRoom(service);
    room.onCreate();
    const client = liveClient("u1");
    room.clients = [client];

    const pending = handlers.get("history")!(client, {}, { id: 1 });
    await tick(); // the handler is now awaiting the database
    room.onFanout(JSON.stringify(kicked)); // the kick arrives while the lookup is in flight
    release(undefined);
    await pending;

    assert.equal(client.userData.guildId, null, "the stale lookup must not restore the guild");
    assert.equal(client.sent.at(-1)?.payload.inGuild, false);
  });

  it("the same guard protects send and onJoin", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    const access = { guildId: "g1", guildName: "Alpha" };
    const service = {
      send: async () => { await gate; return { reply: { ok: true, serverTimeUnix: 1 }, access }; },
      access: async () => { await gate; return access; },
      stateOf: (value: unknown) => ({ inGuild: !!value, guildId: "g1", guildName: "Alpha", serverTimeUnix: 1 }),
    };
    const { room, handlers } = makeRoom(service);
    room.onCreate();

    const sender = liveClient("u1");
    const joiner = liveClient("u1");
    room.clients = [sender, joiner];
    const sending = handlers.get("send")!(sender, { message: "hi" }, { id: 1 });
    const joining = room.onJoin(joiner);
    await tick();
    room.onFanout(JSON.stringify(kicked));
    release(undefined);
    await Promise.all([sending, joining]);

    assert.equal(sender.userData.guildId, null);
    assert.equal(joiner.userData.guildId, null);
    assert.equal(joiner.sent.filter((entry) => entry.payload.inGuild === true).length, 0, "onJoin must not announce the stale guild");
  });

  it("without a concurrent event the lookup result is remembered", async () => {
    const service = {
      getHistory: async () => ({ ok: true, guildId: "g1", guildName: "Alpha", messages: [], serverTimeUnix: 1, access: { guildId: "g1", guildName: "Alpha" } }),
    };
    const { room, handlers } = makeRoom(service);
    room.onCreate();
    const client = liveClient("u1");
    room.clients = [client];
    await handlers.get("history")!(client, {}, { id: 1 });
    assert.equal(client.userData.guildId, "g1");
  });

  it("rate limits guild chat send per user before any database work", async () => {
    const calls: string[] = [];
    const service = { send: async () => { calls.push("send"); return { reply: { ok: true, serverTimeUnix: 1 }, access: null }; } };
    const keys: string[] = [];
    const limiter: RateLimiter = { allow: (key) => { keys.push(key); return keys.length <= 1; } };
    const { room, handlers } = makeRoom(service, { sendLimiter: limiter });
    room.onCreate();
    const client = liveClient("u9");
    room.clients = [client];

    assert.equal((await handlers.get("send")!(client, { message: "a" }, { id: 1 })).ok, true);
    const blocked = await handlers.get("send")!(client, { message: "b" }, { id: 2 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "RATE_LIMIT");
    assert.deepEqual(calls, ["send"]);
    assert.deepEqual(keys, ["u9", "u9"]);
  });

  it("has a built-in per-user send bucket when none is injected", async () => {
    const service = { send: async () => ({ reply: { ok: true, serverTimeUnix: 1 }, access: null }) };
    const { room, handlers } = makeRoom(service);
    room.onCreate();
    const client = liveClient("u9");
    room.clients = [client];
    let blocked = 0;
    for (let i = 0; i < 30; i++) if ((await handlers.get("send")!(client, { message: `m${i}` }, { id: i })).error === "RATE_LIMIT") blocked++;
    assert.ok(blocked >= 10, `expected the burst of 12 to run out, blocked ${blocked}`);
  });
});
