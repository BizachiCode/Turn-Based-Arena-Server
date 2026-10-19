import assert from "node:assert/strict";

import { GuildConfigSchema } from "../src/config/GuildCatalog";
import { normalizeChatFilterConfig, type ChatFilterConfig } from "../src/modules/chat/chat-filter";
import { ChatTextFilter } from "../src/modules/chat/chat-text-filter";
import type { ChatRulesDto } from "../src/modules/chat/chat.dto";
import { ChatOccupancy } from "../src/modules/chat/chat.occupancy";
import { ChatService } from "../src/modules/chat/chat.service";
import { parseGuildChatEvent, routeGuildChatEvent, type GuildChatConnection } from "../src/modules/chat/guild-chat.fanout";
import type { GuildChatFanoutEvent, GuildChatRepository, GuildChatRow, NewGuildChatRow } from "../src/modules/chat/guild-chat.ports";
import { GUILD_CHAT_HISTORY_CAP, GuildChatService, guildChatMembershipOf } from "../src/modules/chat/guild-chat.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { GuildService } from "../src/modules/guild/guild.service";
import { FixedClock } from "../src/shared/kernel/clock";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";
import { InMemoryGuildRepository } from "./support/guild-fakes";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

const RULES: ChatRulesDto = {
  dirInitialPool: 1,
  dirMaxPool: 5,
  dirRecommended: 50,
  msgMin: 1,
  msgMax: 20,
  rateTokensPer10s: 100,
  rateBurst: 100,
  userWindowSec: 10,
  userMaxInWindow: 100,
  dupMuteBaseSec: 5,
};

/** In-memory {@link GuildChatRepository} mirroring the Drizzle one (cap per guild, oldest-first history). */
class InMemoryGuildChatRepository implements GuildChatRepository {
  rows: GuildChatRow[] = [];
  private nextId = 1;

  constructor(private readonly clock: FixedClock) {}

  async insertMessage(row: NewGuildChatRow, capPerGuild: number): Promise<number> {
    const id = this.nextId++;
    this.rows.push({
      id,
      guildId: row.guildId,
      userId: row.userId,
      kind: row.kind,
      nickname: row.sender.nickname,
      iconId: row.sender.iconId,
      level: row.sender.level,
      message: row.message,
      originalMessage: row.original ?? null,
      createdAt: this.clock.now(),
    });
    const inGuild = this.rows.filter((entry) => entry.guildId === row.guildId);
    const excess = inGuild.length - capPerGuild;
    if (excess > 0) {
      const dropped = new Set(inGuild.slice(0, excess).map((entry) => entry.id));
      this.rows = this.rows.filter((entry) => !dropped.has(entry.id));
    }
    return id;
  }

  async fetchHistory(guildId: string, limit: number): Promise<GuildChatRow[]> {
    return this.rows.filter((row) => row.guildId === guildId).slice(-limit).map((row) => ({ ...row }));
  }
}

/** A fake `guild_chat` room: every published event is routed to these connections, like the real rooms do. */
class FakeConnection implements GuildChatConnection {
  received: Array<{ type: string; payload: any }> = [];
  constructor(readonly userId: string, public guildId: string | null) {}
  send(type: "guild_chat_msg" | "guild_chat_state", payload: unknown): void { this.received.push({ type, payload }); }
  messages(): any[] { return this.received.filter((entry) => entry.type === "guild_chat_msg").map((entry) => entry.payload); }
  states(): any[] { return this.received.filter((entry) => entry.type === "guild_chat_state").map((entry) => entry.payload); }
}

function setup(filterConfig?: Partial<ChatFilterConfig>) {
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
    async () => 0,
    filterConfig ? new ChatTextFilter(() => normalizeChatFilterConfig({ enabled: true, words: ["shit"], ...filterConfig }), clock) : null,
  );

  const events: GuildChatFanoutEvent[] = [];
  const connections: FakeConnection[] = [];
  const repo = new InMemoryGuildChatRepository(clock);
  const guildChat = new GuildChatService({
    repo,
    membership: guildChatMembershipOf(guildRepo),
    chat,
    clock,
    fanout: {
      // Through JSON like the presence pub/sub, then routed like a room would.
      publish: (event) => {
        events.push(event);
        const parsed = parseGuildChatEvent(JSON.stringify(event));
        assert.ok(parsed, "fanout events must survive the presence serialization");
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

  const player = (userId: string, name = `Name-${userId}`) => {
    guildRepo.profiles.set(userId, { name, level: 10, iconId: "icon_1" });
    wallets.set(userId, "GO", 100_000);
    return userId;
  };
  const create = async (userId: string, name: string, joinType: "open" | "approval" = "open") =>
    (await guilds.create(userId, { name, description: "", iconId: "emblem_lion", tags: [], joinType, minLevel: 1 })).guild!.guildId;
  /** Opens a `guild_chat` connection: the room resolves the guild like `onJoin`. */
  const connect = async (userId: string) => {
    const connection = new FakeConnection(userId, (await guildChat.access(userId))?.guildId ?? null);
    connections.push(connection);
    return connection;
  };
  const send = (userId: string, message: string) => guildChat.send(userId, "127.0.0.1", message);

  return { clock, guildRepo, repo, chat, guildChat, guilds, events, connections, player, create, connect, send };
}

const memberIdOf = async (guilds: GuildService, viewer: string, name: string) =>
  (await guilds.getState(viewer)).members.find((member) => member.name === name)!.memberId;

describe("Guild chat", () => {
  describe("Word filter original text (player opt-out)", () => {
    async function guildWithTwo(filterConfig: Partial<ChatFilterConfig>) {
      const env = setup(filterConfig);
      ["a1", "a2"].forEach((id) => env.player(id));
      const guildId = await env.create("a1", "Alpha");
      await env.guilds.join("a2", guildId);
      const receiver = await env.connect("a1");
      return { env, receiver };
    }

    it("masked lines carry the original on the live push and in history, clean lines do not", async () => {
      const { env, receiver } = await guildWithTwo({ mode: "mask" });
      await env.send("a2", "oh shit");
      await env.send("a2", "all good");

      const [masked, clean] = receiver.messages();
      assert.equal(masked.message, "oh ****");
      assert.equal(masked.original, "oh shit");
      assert.equal("original" in clean, false);

      assert.deepEqual(env.repo.rows.filter((r) => r.kind === "user").map((r) => [r.message, r.originalMessage]), [["oh ****", "oh shit"], ["all good", null]]);
      const history = await env.guildChat.getHistory("a1", 50);
      assert.deepEqual(history.messages.filter((m) => m.kind === "user").map((m) => [m.message, m.original]), [["oh ****", "oh shit"], ["all good", undefined]]);
    });

    it("allowPlayerOptOut=false omits the original on pushes and history but keeps it stored", async () => {
      const { env, receiver } = await guildWithTwo({ mode: "mask", allowPlayerOptOut: false });
      await env.send("a2", "oh shit");

      assert.equal("original" in receiver.messages()[0], false);
      assert.equal(env.repo.rows.find((r) => r.kind === "user")?.originalMessage, "oh shit");
      const history = await env.guildChat.getHistory("a1", 50);
      assert.equal(history.messages.some((m) => "original" in m), false);
    });

    it("block mode delivers nothing and stores nothing", async () => {
      const { env, receiver } = await guildWithTwo({ mode: "block" });
      const result = await env.send("a2", "oh shit");
      assert.equal(result.reply.error, "MESSAGE_BLOCKED");
      assert.equal(receiver.messages().length, 0);
      assert.equal(env.repo.rows.some((r) => r.kind === "user"), false);
    });

    it("system lines never carry an original", async () => {
      const { env } = await guildWithTwo({ mode: "mask" });
      const history = await env.guildChat.getHistory("a1", 50);
      assert.ok(history.messages.some((m) => m.kind === "system"));
      assert.equal(history.messages.some((m) => "original" in m), false);
    });
  });

  it("delivers lines only to the members of the sender's guild, with a per-recipient self flag", async () => {
    const env = setup();
    ["a1", "a2", "b1", "loner"].forEach((id) => env.player(id));
    const guildA = await env.create("a1", "Alpha");
    await env.guilds.join("a2", guildA);
    await env.create("b1", "Beta");

    const a1 = await env.connect("a1");
    const a2 = await env.connect("a2");
    const b1 = await env.connect("b1");
    const loner = await env.connect("loner");

    const result = await env.send("a2", "  hello   team ");
    assert.deepEqual(result.reply, { ok: true, serverTimeUnix: Math.floor(NOW / 1000) });

    const [toA1] = a1.messages();
    assert.equal(toA1.kind, "user");
    assert.equal(toA1.nickname, "Name-a2");
    assert.equal(toA1.iconId, "icon_1");
    assert.equal(toA1.level, 10);
    assert.equal(toA1.message, "hello team", "sanitized like the global chat");
    assert.equal(toA1.self, false);
    assert.equal(a2.messages()[0].self, true);
    assert.equal(b1.messages().length, 0, "other guilds never receive the line");
    assert.equal(loner.messages().length, 0, "players without a guild never receive the line");
    assert.equal("userId" in toA1, false, "internal user ids are never sent");
    assert.equal("senderUserId" in toA1, false);

    const history = await env.guildChat.getHistory("a1", 50);
    assert.equal(history.ok, true);
    assert.equal(history.guildName, "Alpha");
    assert.deepEqual(history.messages.filter((m) => m.kind === "user").map((m) => [m.message, m.self]), [["hello team", false]]);
    const beta = await env.guildChat.getHistory("b1", 50);
    assert.equal(beta.messages.some((m) => m.kind === "user"), false, "history is scoped to the player's own guild");
  });

  it("refuses history and send without a guild (nothing stored or broadcast)", async () => {
    const env = setup();
    env.player("solo");

    const history = await env.guildChat.getHistory("solo", 50);
    assert.equal(history.ok, false);
    assert.equal(history.error, "GUILD_NOT_MEMBER");
    assert.deepEqual(history.messages, []);

    const sent = await env.send("solo", "hi");
    assert.equal(sent.reply.ok, false);
    assert.equal(sent.reply.error, "GUILD_NOT_MEMBER");
    assert.equal(sent.access, null);
    assert.equal(env.repo.rows.length, 0);
    assert.equal(env.events.length, 0);
  });

  it("posts system lines for create, join, promote, demote, transfer and kick", async () => {
    const env = setup();
    env.player("lead", "Bob");
    env.player("m1", "Ann");
    env.player("m2", "Cid");
    const guildId = await env.create("lead", "Alpha");
    await env.guilds.join("m1", guildId);
    await env.guilds.join("m2", guildId);
    const ann = await memberIdOf(env.guilds, "lead", "Ann");
    const cid = await memberIdOf(env.guilds, "lead", "Cid");
    await env.guilds.setRole("lead", ann, "officer");
    await env.guilds.setRole("lead", ann, "officer"); // unchanged: no line
    await env.guilds.setRole("lead", ann, "member");
    await env.guilds.kick("lead", cid);
    await env.guilds.transfer("lead", ann);

    const history = await env.guildChat.getHistory("lead", 50);
    assert.deepEqual(history.messages.map((m) => [m.kind, m.system, m.nickname, m.message, m.self, m.iconId]), [
      ["system", "created", "Bob", "Bob founded the guild.", false, null],
      ["system", "joined", "Ann", "Ann joined the guild.", false, null],
      ["system", "joined", "Cid", "Cid joined the guild.", false, null],
      ["system", "promoted", "Ann", "Ann is now an officer.", false, null],
      ["system", "demoted", "Ann", "Ann is no longer an officer.", false, null],
      ["system", "kicked", "Cid", "Cid was removed from the guild.", false, null],
      ["system", "leader", "Ann", "Ann is now the guild leader.", false, null],
    ]);
  });

  it("removes access at once when a member is kicked or leaves, and grants it when a request is accepted", async () => {
    const env = setup();
    ["lead", "kicked", "quitter", "applicant"].forEach((id) => env.player(id));
    const guildId = await env.create("lead", "Alpha", "approval");
    for (const id of ["kicked", "quitter"]) {
      await env.guilds.join(id, guildId);
      const requestId = (await env.guilds.listRequests("lead")).requests[0].requestId;
      await env.guilds.acceptRequest("lead", requestId);
    }

    const lead = await env.connect("lead");
    const kicked = await env.connect("kicked");
    const quitter = await env.connect("quitter");
    const applicant = await env.connect("applicant");
    assert.equal(kicked.guildId, guildId);

    await env.guilds.kick("lead", await memberIdOf(env.guilds, "lead", "Name-kicked"));
    assert.equal(kicked.guildId, null);
    assert.deepEqual(kicked.states().at(-1), { inGuild: false, guildId: null, guildName: null, serverTimeUnix: Math.floor(NOW / 1000) });
    assert.equal(kicked.messages().at(-1).system, "kicked", "the kicked player still sees the line about them");

    await env.guilds.leave("quitter");
    assert.equal(quitter.guildId, null);

    await env.guilds.join("applicant", guildId);
    assert.equal(applicant.guildId, null, "a pending request gives no access");
    const requestId = (await env.guilds.listRequests("lead")).requests[0].requestId;
    await env.guilds.acceptRequest("lead", requestId);
    assert.equal(applicant.guildId, guildId);
    assert.deepEqual(applicant.states().at(-1), { inGuild: true, guildId, guildName: "Alpha", serverTimeUnix: Math.floor(NOW / 1000) });
    assert.equal(applicant.messages().at(-1).system, "joined", "the new member receives their own join line");

    const before = { kicked: kicked.messages().length, quitter: quitter.messages().length };
    await env.send("lead", "welcome!");
    assert.equal(kicked.messages().length, before.kicked, "kicked players stop receiving lines");
    assert.equal(quitter.messages().length, before.quitter, "players who left stop receiving lines");
    assert.equal(applicant.messages().at(-1).message, "welcome!");
    assert.equal(lead.messages().at(-1).self, true);

    assert.equal((await env.send("kicked", "let me in")).reply.error, "GUILD_NOT_MEMBER");
    assert.equal((await env.guildChat.getHistory("quitter", 10)).error, "GUILD_NOT_MEMBER");
  });

  it("disbanding (leader leaving alone) removes access without posting a line", async () => {
    const env = setup();
    env.player("solo");
    const guildId = await env.create("solo", "Alone");
    const solo = await env.connect("solo");
    const lines = env.repo.rows.length;

    const left = await env.guilds.leave("solo");
    assert.equal(left.disbanded, true);
    assert.equal(solo.guildId, null);
    assert.equal(env.repo.rows.filter((row) => row.guildId === guildId).length, lines, "no line for a deleted guild");
    assert.deepEqual(env.events.at(-1), { type: "membership", userId: "solo", guildId: null, guildName: null });
  });

  it("reuses the global chat moderation: length, invalid text, duplicate mutes shared with the global channels", async () => {
    const env = setup();
    env.player("u1");
    await env.create("u1", "Alpha");

    assert.equal((await env.send("u1", "   ")).reply.error, "INVALID");
    await env.send("u1", "x".repeat(50));
    assert.equal(env.repo.rows.at(-1).message, "x".repeat(RULES.msgMax), "cut to msgMax");

    for (let i = 0; i < 3; i++) assert.equal((await env.send("u1", "spam")).reply.ok, true);
    const muted = await env.send("u1", "spam");
    assert.equal(muted.reply.ok, false);
    assert.equal(muted.reply.error, "MUTED");
    assert.ok(muted.reply.muteUntilUnix > Math.floor(NOW / 1000));

    const global = await env.chat.sendMessage({ channel: 0, userId: "u1", ipAddress: "127.0.0.1", message: "other" }, RULES);
    assert.equal(global.reply.error, "MUTED", "a mute applies to every channel");
    assert.equal((await env.guildChat.getHistory("u1", 10)).muteUntilUnix, muted.reply.muteUntilUnix);
  });

  it("keeps the newest lines per guild and honours the history limit", async () => {
    const env = setup();
    env.player("a");
    env.player("b");
    const alpha = await env.create("a", "Alpha");
    const beta = await env.create("b", "Beta");
    for (let i = 0; i < GUILD_CHAT_HISTORY_CAP + 5; i++) {
      env.clock.advance(31_000); // past the duplicate window and the rate limits
      await env.send("a", `line ${i}`);
    }

    assert.equal(env.repo.rows.filter((row) => row.guildId === alpha).length, GUILD_CHAT_HISTORY_CAP);
    assert.equal(env.repo.rows.filter((row) => row.guildId === beta).length, 1, "other guilds keep their own lines");
    const history = await env.guildChat.getHistory("a", 3);
    assert.deepEqual(history.messages.map((m) => m.message), [`line ${GUILD_CHAT_HISTORY_CAP + 2}`, `line ${GUILD_CHAT_HISTORY_CAP + 3}`, `line ${GUILD_CHAT_HISTORY_CAP + 4}`]);
  });

  it("ignores malformed fanout payloads and survives a failing fanout", async () => {
    assert.equal(parseGuildChatEvent("not json"), null);
    assert.equal(parseGuildChatEvent(JSON.stringify({ type: "message" })), null);
    assert.equal(parseGuildChatEvent(JSON.stringify({ type: "other", userId: "x" })), null);

    const env = setup();
    env.player("u1");
    await env.create("u1", "Alpha");
    const broken = new GuildChatService({
      repo: env.repo,
      membership: guildChatMembershipOf(env.guildRepo),
      chat: env.chat,
      clock: env.clock,
      fanout: { publish: () => { throw new Error("presence down"); } },
    });
    const sent = await broken.send("u1", "127.0.0.1", "still stored");
    assert.equal(sent.reply.ok, true);
    assert.equal(env.repo.rows.at(-1).message, "still stored");
  });
});
