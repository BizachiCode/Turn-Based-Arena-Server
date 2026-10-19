import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error";
import { DmService } from "../src/modules/social/dm.service";
import type { ModerationResult } from "../src/modules/chat/chat.service";
import { InMemoryDmRepository, socialConfig, socialKit, T0 } from "./support/social-fakes";

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

function setup(directMessages: Parameters<typeof socialConfig>[0]["directMessages"] = {}) {
  const kit = socialKit(socialConfig({ directMessages }));
  const repo = new InMemoryDmRepository(kit.clock);
  const moderation: { next: ModerationResult | null } = { next: null };
  const chat = {
    async moderate(_userId: string, _ip: string, raw: string): Promise<ModerationResult> {
      if (moderation.next) return moderation.next;
      return raw.includes("darn") ? { ok: true, message: raw.replace("darn", "****"), original: raw } : { ok: true, message: raw.trim() };
    },
    originalField: (original: string | null | undefined) => (original ? { original } : {}),
  };
  const service = new DmService({
    repo: repo as never,
    friendships: kit.repo,
    directory: kit.repo,
    status: kit.status,
    chat,
    notifier: kit.notifier,
    uow: kit.uow,
    clock: kit.clock,
    config: kit.config,
  });
  for (const id of ["ann", "bob", "cid"]) kit.repo.addPlayer(id);
  const befriend = (a: string, b: string) => kit.repo.rows.push({ id: `${a}${b}`, requesterId: a, addresseeId: b, status: "accepted", createdAt: new Date(T0), respondedAt: new Date(T0) });
  return { ...kit, dms: repo, service, moderation, befriend };
}

describe("Private messages", () => {
  it("friends exchange lines: pushes to the peer and the sender's devices, unread counts and read markers", async () => {
    const { service, notifier, befriend, clock } = setup();
    befriend("ann", "bob");

    const sent = await service.send("ann", "1.1.1.1", "bob", "  hello bob ");
    assert.equal(sent.ok, true);
    assert.equal(sent.message?.message, "hello bob");
    assert.equal(sent.message?.self, true);
    const toBob = notifier.events.find((entry) => entry.userId === "bob")!.event as any;
    assert.equal(toBob.kind, "dm_message");
    assert.equal(toBob.peerUserId, "ann");
    assert.equal(toBob.message.self, false);
    assert.equal(toBob.sender.userId, "ann");
    assert.ok(notifier.events.some((entry) => entry.userId === "ann" && (entry.event as any).peerUserId === "bob"), "sender's other devices");

    clock.advance(1000);
    await service.send("ann", "1.1.1.1", "bob", "darn it");
    const bobView = await service.conversations("bob");
    assert.equal(bobView.unreadTotal, 2);
    assert.equal(bobView.conversations[0].peer.userId, "ann");
    assert.equal(bobView.conversations[0].lastMessage?.message, "**** it");
    assert.equal(bobView.conversations[0].lastMessage?.original, "darn it");
    assert.equal(bobView.conversations[0].canMessage, true);
    assert.equal((await service.conversations("ann")).unreadTotal, 0, "own lines are read");

    const history = await service.history("bob", "ann", null);
    assert.deepEqual(history.messages.map((line) => [line.message, line.self]), [["hello bob", false], ["**** it", false]]);
    const read = await service.read("bob", "ann", history.messages[0].id);
    assert.deepEqual([read.unread, read.unreadTotal], [1, 1]);
    assert.deepEqual((await service.read("bob", "ann", history.messages[1].id)).unreadTotal, 0);
  });

  it("refuses strangers and blocks either way, allows guild mates only when configured", async () => {
    const plain = setup();
    await assert.rejects(plain.service.send("ann", "ip", "cid", "hi"), isError("DM_NOT_ALLOWED"));
    plain.befriend("ann", "cid");
    plain.repo.blocks.push({ blockerId: "cid", blockedId: "ann", createdAt: new Date(T0) });
    await assert.rejects(plain.service.send("ann", "ip", "cid", "hi"), isError("DM_NOT_ALLOWED"));
    await assert.rejects(plain.service.send("cid", "ip", "ann", "hi"), isError("DM_NOT_ALLOWED"));
    assert.equal((await plain.service.history("ann", "cid", null)).canMessage, false);

    const guild = setup({ allowGuildMembers: true });
    guild.repo.guilds.set("ann", { guildId: "g1", guildName: "G" });
    guild.repo.guilds.set("bob", { guildId: "g1", guildName: "G" });
    guild.repo.guilds.set("cid", { guildId: "g2", guildName: "H" });
    assert.equal((await guild.service.send("ann", "ip", "bob", "hi mate")).ok, true);
    await assert.rejects(guild.service.send("ann", "ip", "cid", "hi"), isError("DM_NOT_ALLOWED"));
  });

  it("forwards the chat moderation answer (mute, rate limit) without storing anything", async () => {
    const { service, befriend, moderation, dms } = setup();
    befriend("ann", "bob");
    moderation.next = { ok: false, reply: { ok: false, error: "MUTED", muteUntilUnix: 123, serverTimeUnix: 100 } };
    assert.deepEqual(await service.send("ann", "ip", "bob", "hi"), { ok: false, error: "MUTED", muteUntilUnix: 123, serverTimeUnix: 100 });
    assert.equal(dms.lines.length, 0);
  });

  it("pages the history backwards and keeps only the newest lines of a conversation", async () => {
    const { service, befriend, dms } = setup({ historyPerConversation: 20, historyPageSize: 10 });
    befriend("ann", "bob");
    for (let index = 1; index <= 25; index++) await service.send(index % 2 ? "ann" : "bob", "ip", index % 2 ? "bob" : "ann", `line ${index}`);
    assert.equal(dms.lines.length, 20, "trimmed to the cap");

    const first = await service.history("ann", "bob", null);
    assert.deepEqual(first.messages.map((line) => line.message), Array.from({ length: 10 }, (_, i) => `line ${16 + i}`));
    assert.equal(first.hasMore, true);
    const second = await service.history("ann", "bob", first.messages[0].id);
    assert.deepEqual(second.messages.map((line) => line.message), Array.from({ length: 10 }, (_, i) => `line ${6 + i}`));
    assert.equal(second.hasMore, false);
  });

  it("history is scoped to the caller's own conversation", async () => {
    const { service, befriend } = setup();
    befriend("ann", "bob");
    await service.send("ann", "ip", "bob", "secret");
    assert.deepEqual((await service.history("cid", "bob", null)).messages, [], "cid only sees cid <-> bob");
    await assert.rejects(service.history("ann", "ann", null), isError("SOCIAL_SELF"));
    await assert.rejects(service.history("ann", "ghost", null), isError("PLAYER_NOT_FOUND"));
    const disabled = setup({ enabled: false });
    await assert.rejects(disabled.service.conversations("ann"), isError("DM_DISABLED"));
  });
});
