import assert from "node:assert/strict";

import type { ChatRow, ChatRulesDto, ChatSenderDto } from "../src/modules/chat/chat.dto";
import { ChatOccupancy } from "../src/modules/chat/chat.occupancy";
import type { ChatRepository, ChatSenderResolver } from "../src/modules/chat/chat.ports";
import { ChatService } from "../src/modules/chat/chat.service";
import { ProfileService } from "../src/modules/profile/profile.service";
import { FixedClock } from "../src/shared/kernel/clock";
import { createSeededRandom } from "../src/shared/kernel/random";
import { InMemoryProfileRepository } from "./support/fakes";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

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

/** In-memory {@link ChatRepository} mirroring the Drizzle one (cap per channel, oldest-first history). */
class InMemoryChatRepository implements ChatRepository {
  rows: ChatRow[] = [];
  private nextId = 1;

  constructor(private readonly clock: FixedClock) {}

  async insertMessage(channel: number, userId: string, sender: ChatSenderDto, message: string, capPerChannel: number, original: string | null = null): Promise<void> {
    this.rows.push({
      id: this.nextId++,
      channel,
      user_id: userId,
      nickname: sender.nickname,
      icon_id: sender.iconId,
      level: sender.level,
      message,
      original_message: original,
      created_at: this.clock.now(),
    });
    const inChannel = this.rows.filter((row) => row.channel === channel);
    const excess = inChannel.length - capPerChannel;
    if (excess > 0) {
      const dropped = new Set(inChannel.slice(0, excess).map((row) => row.id));
      this.rows = this.rows.filter((row) => !dropped.has(row.id));
    }
  }

  async fetchHistory(channel: number, limit: number): Promise<ChatRow[]> {
    return this.rows.filter((row) => row.channel === channel).slice(-limit).map((row) => ({ ...row }));
  }
}

/** Wires the chat service exactly like `container.ts` (sender snapshot from `ProfileService.getProfile`). */
function setup(resolverOverride?: ChatSenderResolver) {
  const clock = new FixedClock(T0);
  const profilesRepo = new InMemoryProfileRepository();
  const profiles = new ProfileService(
    profilesRepo,
    { exists: () => true, defaultIconId: () => "icon_default" },
    () => ({ minLength: 3, maxLength: 32, canUseSpecialChar: true }),
    createSeededRandom(7),
  );
  const repo = new InMemoryChatRepository(clock);
  const resolver: ChatSenderResolver = resolverOverride ?? (async (userId) => {
    const profile = await profiles.getProfile(userId);
    return profile ? { nickname: profile.name, iconId: profile.iconId, level: profile.level } : null;
  });
  const chat = new ChatService(repo, new ChatOccupancy(), resolver, () => RULES, clock);
  return { clock, profilesRepo, profiles, repo, chat };
}

function send(chat: ChatService, userId: string, message: string) {
  return chat.sendMessage({ channel: 0, userId, ipAddress: "127.0.0.1", message }, RULES);
}

describe("Chat: sender icon and level", () => {
  it("broadcasts and persists the sender's profile icon id and account level", async () => {
    const env = setup();
    env.profilesRepo.rows.set("u1", { name: "Alice", iconId: "icon_dragon", level: 27, currentExp: 0 });

    const result = await send(env.chat, "u1", "hello");

    assert.equal(result.reply.ok, true);
    assert.deepEqual(result.broadcast, {
      userId: "u1",
      nickname: "Alice",
      iconId: "icon_dragon",
      level: 27,
      channel: 0,
      message: "hello",
      serverTimeUnix: Math.floor(T0 / 1000),
    });
    assert.equal(env.repo.rows[0].icon_id, "icon_dragon");
    assert.equal(env.repo.rows[0].level, 27);
  });

  it("returns iconId and level in history", async () => {
    const env = setup();
    env.profilesRepo.rows.set("u1", { name: "Alice", iconId: "icon_dragon", level: 27, currentExp: 0 });
    env.profilesRepo.rows.set("u2", { name: "Bob", iconId: "icon_slime", level: 3, currentExp: 0 });
    await send(env.chat, "u1", "hi bob");
    await send(env.chat, "u2", "hi alice");

    const history = await env.chat.getHistory(0, "u1", 50);

    assert.equal(history.ok, true);
    assert.deepEqual(
      history.messages.map((m) => ({ nickname: m.nickname, iconId: m.iconId, level: m.level, message: m.message })),
      [
        { nickname: "Alice", iconId: "icon_dragon", level: 27, message: "hi bob" },
        { nickname: "Bob", iconId: "icon_slime", level: 3, message: "hi alice" },
      ],
    );
  });

  it("snapshots icon and level at send time (later profile changes do not rewrite history)", async () => {
    const env = setup();
    env.profilesRepo.rows.set("u1", { name: "Alice", iconId: "icon_dragon", level: 5, currentExp: 0 });
    await send(env.chat, "u1", "before");

    await env.profilesRepo.updateIcon("u1", "icon_phoenix");
    env.profilesRepo.rows.get("u1")!.level = 6;
    env.clock.advance(1000);
    const after = await send(env.chat, "u1", "after");

    assert.equal(after.broadcast?.iconId, "icon_phoenix");
    assert.equal(after.broadcast?.level, 6);
    const history = await env.chat.getHistory(0, "u1", 50);
    assert.deepEqual(history.messages.map((m) => [m.iconId, m.level]), [["icon_dragon", 5], ["icon_phoenix", 6]]);
  });

  it("uses the configured default icon when the stored profile icon is empty", async () => {
    const env = setup();
    env.profilesRepo.rows.set("u1", { name: "Alice", iconId: "", level: 2, currentExp: 0 });

    const result = await send(env.chat, "u1", "hello");

    assert.equal(result.broadcast?.iconId, "icon_default");
    assert.equal(result.broadcast?.level, 2);
  });

  it("falls back to Player / null icon / level 1 when the profile is missing or the lookup fails", async () => {
    const missing = setup();
    const noProfile = await send(missing.chat, "ghost", "boo");
    assert.equal(noProfile.broadcast?.nickname, "Player");
    assert.equal(noProfile.broadcast?.iconId, null);
    assert.equal(noProfile.broadcast?.level, 1);

    const failing = setup(async () => { throw new Error("db down"); });
    const failed = await send(failing.chat, "u1", "still works");
    assert.equal(failed.reply.ok, true);
    assert.equal(failed.broadcast?.nickname, "Player");
    assert.equal(failed.broadcast?.iconId, null);
    assert.equal(failed.broadcast?.level, 1);
  });

  it("loads rows without an icon (null icon_id) with iconId null and level 1", async () => {
    const env = setup();
    env.repo.rows.push({
      id: 999,
      channel: 0,
      user_id: "old",
      nickname: "Veteran",
      icon_id: null,
      level: 1,
      message: "no icon",
      original_message: null,
      created_at: new Date(T0 - 60_000),
    });
    // Defensive: a corrupt/zero level is normalized to 1.
    env.repo.rows.push({
      id: 1000,
      channel: 0,
      user_id: "old2",
      nickname: "Odd",
      icon_id: "  ",
      level: 0,
      message: "weird row",
      original_message: null,
      created_at: new Date(T0 - 30_000),
    });

    const history = await env.chat.getHistory(0, "u1", 50);

    assert.deepEqual(history.messages.map((m) => [m.nickname, m.iconId, m.level]), [["Veteran", null, 1], ["Odd", null, 1]]);
  });

  it("does not broadcast icon/level for rejected messages", async () => {
    const env = setup();
    env.profilesRepo.rows.set("u1", { name: "Alice", iconId: "icon_dragon", level: 27, currentExp: 0 });

    const result = await send(env.chat, "u1", "   ");

    assert.equal(result.reply.ok, false);
    assert.equal(result.reply.error, "INVALID");
    assert.equal(result.broadcast, undefined);
    assert.equal(env.repo.rows.length, 0);
  });
});
