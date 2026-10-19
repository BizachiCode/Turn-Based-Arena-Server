import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  applyChatFilter,
  compileChatFilter,
  normalizeChatFilterConfig,
  type ChatFilterConfig,
} from "../src/modules/chat/chat-filter";
import { ChatTextFilter } from "../src/modules/chat/chat-text-filter";
import type { ChatRow, ChatRulesDto, ChatSenderDto } from "../src/modules/chat/chat.dto";
import { ChatOccupancy } from "../src/modules/chat/chat.occupancy";
import type { ChatRepository } from "../src/modules/chat/chat.ports";
import { ChatService } from "../src/modules/chat/chat.service";
import { ProfileService } from "../src/modules/profile/profile.service";
import { FixedClock } from "../src/shared/kernel/clock";
import { createSeededRandom } from "../src/shared/kernel/random";
import { InMemoryProfileRepository } from "./support/fakes";

type FixtureCase = { config: string; input: string; matched: boolean; output: string };
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "chat-filter-cases.json"), "utf8")) as {
  configs: Record<string, ChatFilterConfig>;
  cases: FixtureCase[];
};

describe("Chat filter (pure module)", () => {
  const compiled = Object.fromEntries(Object.entries(fixture.configs).map(([name, config]) => [name, compileChatFilter(config)]));

  it("matches every parity case of test/fixtures/chat-filter-cases.json", () => {
    assert.ok(fixture.cases.length > 40);
    for (const entry of fixture.cases) {
      const result = applyChatFilter(compiled[entry.config], entry.input);
      assert.equal(result.matched, entry.matched, `matched: [${entry.config}] ${JSON.stringify(entry.input)}`);
      assert.equal(result.text, entry.output, `output: [${entry.config}] ${JSON.stringify(entry.input)}`);
    }
  });

  it("resists case, accents, repeated letters, leetspeak and separators", () => {
    const filter = compiled.whole;
    for (const evasion of ["SHIT", "shít", "sh1t", "5h!t".replace("!", "i"), "shhhiiit", "s.h.i.t", "s h i t", "S-H-I-T", "$hit"]) {
      assert.equal(applyChatFilter(filter, `well ${evasion} happens`).matched, true, evasion);
    }
  });

  it("does not flag innocent words when wholeWordOnly is true (Scunthorpe)", () => {
    const filter = compileChatFilter({ enabled: true, wholeWordOnly: true, words: ["cunt", "ass", "shit", "hell"] });
    for (const text of ["Scunthorpe United", "assassin", "classic", "shitake mushrooms", "hello shell", "as soon as"]) {
      assert.equal(applyChatFilter(filter, text).matched, false, text);
    }
  });

  it("lets the allow list win over banned substrings", () => {
    const loose = compileChatFilter({ enabled: true, wholeWordOnly: false, words: ["cunt", "ass"], allowList: ["scunthorpe", "class"] });
    assert.equal(applyChatFilter(loose, "Scunthorpe class").matched, false);
    assert.equal(applyChatFilter(loose, "you ass").text, "you ***");
    // An allow-listed word also wins when the banned entry equals it.
    const both = compileChatFilter({ enabled: true, wholeWordOnly: true, words: ["ass"], allowList: ["ass"] });
    assert.equal(applyChatFilter(both, "ass").matched, false);
  });

  it("masks with the configured char and keeps the rest of the text", () => {
    const filter = compileChatFilter({ enabled: true, maskChar: "#", words: ["fuck"] });
    assert.equal(applyChatFilter(filter, "Oh f.u.c.k, really?").text, "Oh #######, really?");
    assert.equal(normalizeChatFilterConfig({ maskChar: "  " }).maskChar, "*");
    assert.equal(normalizeChatFilterConfig({ maskChar: "ab" }).maskChar, "a");
  });

  it("has safe defaults for a missing or malformed config", () => {
    for (const raw of [undefined, null, 5, "x", [], {}, { words: "nope", allowList: [1, 2], mode: "weird" }]) {
      const config = normalizeChatFilterConfig(raw);
      assert.equal(config.enabled, false);
      assert.equal(config.mode, "mask");
      assert.equal(config.wholeWordOnly, true);
      assert.deepEqual(config.words, []);
      assert.equal(applyChatFilter(compileChatFilter(config), "shit").matched, false);
    }
    assert.equal(normalizeChatFilterConfig({ enabled: true, mode: "block", wholeWordOnly: false }).mode, "block");
  });

  it("ignores one-letter entries and handles empty or huge inputs quickly", () => {
    const words = Array.from({ length: 2000 }, (_value, index) => `badword${index}`);
    const filter = compileChatFilter({ enabled: true, words: ["a", ...words] });
    assert.equal(filter.wordCount, 2000);
    const started = Date.now();
    const text = "a ".repeat(120) + "x".repeat(200);
    applyChatFilter(filter, text);
    applyChatFilter(filter, "badword1999 and a b a d w o r d 7");
    assert.ok(Date.now() - started < 1000, "filtering must stay cheap");
    assert.equal(applyChatFilter(filter, "").matched, false);
  });
});

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const RULES: ChatRulesDto = {
  dirInitialPool: 1, dirMaxPool: 5, dirRecommended: 50, msgMin: 1, msgMax: 200,
  rateTokensPer10s: 100, rateBurst: 100, userWindowSec: 10, userMaxInWindow: 100, dupMuteBaseSec: 5,
};

class MemoryChat implements ChatRepository {
  rows: ChatRow[] = [];
  async insertMessage(channel: number, userId: string, sender: ChatSenderDto, message: string, _cap?: number, original: string | null = null): Promise<number> {
    const id = this.rows.length + 1;
    this.rows.push({ id, channel, user_id: userId, nickname: sender.nickname, icon_id: sender.iconId, level: sender.level, message, original_message: original, created_at: new Date(T0) });
    return id;
  }
  async fetchHistory(): Promise<ChatRow[]> {
    return this.rows;
  }
}

function chatWith(config: Partial<ChatFilterConfig>) {
  const clock = new FixedClock(T0);
  const filter = new ChatTextFilter(() => normalizeChatFilterConfig({ enabled: true, words: ["shit", "fuck"], ...config }), clock);
  const repo = new MemoryChat();
  const chat = new ChatService(repo, new ChatOccupancy(), async () => ({ nickname: "Alice", iconId: null, level: 3 }), () => RULES, clock, async () => 0, filter);
  const send = (userId: string, message: string) => chat.sendMessage({ channel: 0, userId, ipAddress: "10.0.0.1", message }, RULES);
  return { chat, repo, filter, send };
}

describe("Chat filter in the chat service", () => {
  it("mask mode stores and broadcasts the masked line and counts it per player", async () => {
    const env = chatWith({ mode: "mask" });
    const result = await env.send("u1", "this is f u c k shit");
    assert.equal(result.reply.ok, true);
    assert.equal(result.broadcast?.message, "this is ******* ****");
    assert.equal(env.repo.rows[0].message, "this is ******* ****");
    assert.equal(result.broadcast?.id, 1);

    await env.send("u1", "clean line");
    await env.send("u2", "shit");
    const snapshot = env.filter.snapshot();
    assert.equal(snapshot.masked, 2);
    assert.equal(snapshot.blocked, 0);
    assert.deepEqual(snapshot.players.map((p) => [p.userId, p.masked, p.blocked]), [["u1", 1, 0], ["u2", 1, 0]]);
  });

  it("block mode refuses the line with MESSAGE_BLOCKED and stores nothing", async () => {
    const env = chatWith({ mode: "block" });
    const result = await env.send("u1", "what the fuck");
    assert.equal(result.reply.ok, false);
    assert.equal(result.reply.error, "MESSAGE_BLOCKED");
    assert.equal(result.broadcast, undefined);
    assert.equal(env.repo.rows.length, 0);
    assert.equal(env.filter.snapshot().players[0].blocked, 1);
    assert.equal((await env.send("u1", "what the duck")).reply.ok, true);
  });

  it("moderate() (shared with guild chat) applies the same filter", async () => {
    const env = chatWith({ mode: "block" });
    const blocked = await env.chat.moderate("u1", "10.0.0.1", "shit happens");
    assert.equal(blocked.ok, false);
    const masked = await chatWith({ mode: "mask" }).chat.moderate("u1", "10.0.0.1", "shit happens");
    assert.deepEqual(masked, { ok: true, message: "**** happens", original: "shit happens" });
  });

  describe("Original text (player opt-out)", () => {
    it("moderate() keeps the original only when the filter changed the line", async () => {
      const env = chatWith({ mode: "mask" });
      assert.deepEqual(await env.chat.moderate("u1", "10.0.0.1", "  shit   happens "), { ok: true, message: "**** happens", original: "shit happens" });
      assert.deepEqual(await env.chat.moderate("u1", "10.0.0.1", "all clean"), { ok: true, message: "all clean" });
    });

    it("stores the original and sends it on the broadcast and in history, only for masked lines", async () => {
      const env = chatWith({ mode: "mask" });
      const masked = await env.send("u1", "what the fuck");
      const clean = await env.send("u1", "clean line");
      assert.equal(masked.broadcast?.message, "what the ****");
      assert.equal(masked.broadcast?.original, "what the fuck");
      assert.equal("original" in clean.broadcast!, false);
      assert.deepEqual(env.repo.rows.map((row) => [row.message, row.original_message]), [["what the ****", "what the fuck"], ["clean line", null]]);

      const history = await env.chat.getHistory(0, "u2", 50);
      assert.deepEqual(history.messages.map((m) => [m.message, m.original]), [["what the ****", "what the fuck"], ["clean line", undefined]]);
      assert.equal("original" in history.messages[1], false);
    });

    it("allowPlayerOptOut=false never exposes the original (live and history) but still stores it", async () => {
      const env = chatWith({ mode: "mask", allowPlayerOptOut: false });
      const result = await env.send("u1", "what the fuck");
      assert.equal(result.broadcast?.message, "what the ****");
      assert.equal("original" in result.broadcast!, false);
      assert.equal(env.repo.rows[0].original_message, "what the fuck", "GMs and reports still need it");
      const history = await env.chat.getHistory(0, "u2", 50);
      assert.equal("original" in history.messages[0], false);
    });

    it("the option is normalized: on by default, only an explicit true keeps it on", () => {
      assert.equal(normalizeChatFilterConfig({}).allowPlayerOptOut, true);
      assert.equal(normalizeChatFilterConfig({ allowPlayerOptOut: false }).allowPlayerOptOut, false);
      assert.equal(normalizeChatFilterConfig({ allowPlayerOptOut: "no" }).allowPlayerOptOut, false);
    });

    it("block mode is unchanged: nothing is delivered and there is no original", async () => {
      const env = chatWith({ mode: "block", allowPlayerOptOut: true });
      const result = await env.send("u1", "what the fuck");
      assert.equal(result.reply.error, "MESSAGE_BLOCKED");
      assert.equal(result.broadcast, undefined);
      assert.equal(env.repo.rows.length, 0);
      assert.equal(env.filter.allowsOriginal(), false);
    });

    it("duplicate detection still compares the masked text", async () => {
      const env = chatWith({ mode: "mask" });
      // "shit" and "fuck" both mask to four asterisks, so the fourth identical masked line mutes the player.
      for (const text of ["shit", "fuck", "shit"]) assert.equal((await env.send("u1", text)).reply.ok, true);
      assert.equal((await env.send("u1", "fuck")).reply.error, "MUTED");
    });
  });

  it("does nothing while disabled (the default)", async () => {
    const env = chatWith({ enabled: false });
    assert.equal((await env.send("u1", "shit")).broadcast?.message, "shit");
  });

  it("preview() reports what the chat would do without counting it", () => {
    const env = chatWith({ mode: "block" });
    assert.deepEqual(env.filter.preview("a shit"), { enabled: true, mode: "block", matched: true, blocked: true, input: "a shit", output: "a shit" });
    assert.equal(chatWith({ mode: "mask" }).filter.preview("a shit").output, "a ****");
    assert.equal(env.filter.snapshot().blocked, 0);
  });

  it("rejects() only refuses texts in block mode (names, guild texts)", () => {
    assert.equal(chatWith({ mode: "block" }).filter.rejects("Mr Shit"), true);
    assert.equal(chatWith({ mode: "block" }).filter.rejects("Mr Nice"), false);
    assert.equal(chatWith({ mode: "mask" }).filter.rejects("Mr Shit"), false);
  });

  it("recompiles when the config object changes", () => {
    let config = normalizeChatFilterConfig({ enabled: true, words: ["alpha"] });
    const filter = new ChatTextFilter(() => config, new FixedClock(T0));
    assert.equal(filter.preview("alpha beta").matched, true);
    config = normalizeChatFilterConfig({ enabled: true, words: ["beta"] });
    assert.equal(filter.preview("alpha beta").output, "alpha ****");
  });
});

describe("Chat filter on nicknames", () => {
  function profiles(mode: "block" | "mask") {
    const clock = new FixedClock(T0);
    const filter = new ChatTextFilter(() => normalizeChatFilterConfig({ enabled: true, mode, words: ["badname"] }), clock);
    const repo = new InMemoryProfileRepository();
    repo.rows.set("u1", { name: "Alice", iconId: "icon", level: 1, currentExp: 0 });
    const service = new ProfileService(repo, { exists: () => true, defaultIconId: () => "icon" }, () => ({ minLength: 3, maxLength: 32, canUseSpecialChar: true }), createSeededRandom(1), filter);
    return { service, repo };
  }

  it("refuses a banned nickname in block mode with TEXT_BLOCKED", async () => {
    const { service } = profiles("block");
    await assert.rejects(service.changeNickname("u1", "B4dN4me"), (error: { errorCode?: string }) => error.errorCode === "TEXT_BLOCKED");
    assert.deepEqual(await service.changeNickname("u1", "Goodname"), { nickname: "Goodname" });
  });

  it("lets operators rename past the filter and leaves mask mode alone", async () => {
    const block = profiles("block");
    assert.deepEqual(await block.service.changeNickname("u1", "badname", { operator: true }), { nickname: "badname" });
    const mask = profiles("mask");
    assert.deepEqual(await mask.service.changeNickname("u1", "badname"), { nickname: "badname" });
  });
});
