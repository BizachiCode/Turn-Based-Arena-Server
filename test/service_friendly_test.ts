import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error";
import { FriendlyBattleService, FriendlyRoomBusyError } from "../src/modules/social/friendly.service";
import { InMemoryFriendlyMatchRepository, socialConfig, socialKit, T0 } from "./support/social-fakes";

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

function setup(friendlyBattle: Parameters<typeof socialConfig>[0]["friendlyBattle"] = {}) {
  const kit = socialKit(socialConfig({ friendlyBattle }));
  const matches = new InMemoryFriendlyMatchRepository();
  const rooms = { created: [] as string[], fail: null as Error | null, gone: new Set<string>() };
  let counter = 0;
  const service = new FriendlyBattleService({
    matches,
    friendships: kit.repo,
    directory: kit.repo,
    status: kit.status,
    notifier: kit.notifier,
    uow: kit.uow,
    clock: kit.clock,
    config: kit.config,
    newId: () => `M${String(++counter).padStart(25, "0")}`,
    rooms: {
      createMatchRoom: async (matchId) => {
        if (rooms.fail) throw rooms.fail;
        rooms.created.push(matchId);
        return `room-${matchId}`;
      },
      roomExists: async (roomId) => !rooms.gone.has(roomId),
    },
  });
  for (const id of ["ann", "bob", "cid"]) {
    kit.repo.addPlayer(id);
    kit.repo.connections.set(id, { online: true, lastSeenAt: new Date(T0) });
  }
  const befriend = (a: string, b: string) => kit.repo.rows.push({ id: `${a}${b}`, requesterId: a, addresseeId: b, status: "accepted", createdAt: new Date(T0), respondedAt: new Date(T0) });
  return { ...kit, matches, rooms, service, befriend };
}

describe("Friendly battle challenges", () => {
  it("challenges an online friend, who accepts: the match room is created and the challenger is told where", async () => {
    const { service, notifier, befriend, rooms, matches } = setup();
    befriend("ann", "bob");

    const sent = await service.send("ann", "bob");
    assert.equal(sent.challenge.direction, "outgoing");
    assert.equal(sent.challenge.expiresAtUnix - sent.challenge.createdAtUnix, 60);
    const pushed = notifier.events.find((entry) => entry.userId === "bob")!.event as any;
    assert.equal(pushed.kind, "friendly_challenge");
    assert.equal(pushed.challenge.direction, "incoming");
    assert.equal(pushed.challenge.player.userId, "ann");

    const listed = await service.list("bob");
    assert.deepEqual(listed.incoming.map((entry) => entry.challengeId), [sent.challenge.challengeId]);

    notifier.clear();
    const accepted = await service.accept("bob", sent.challenge.challengeId);
    assert.equal(accepted.match.roomId, `room-${sent.challenge.challengeId}`);
    assert.equal(accepted.match.opponent.userId, "ann");
    assert.deepEqual(rooms.created, [sent.challenge.challengeId]);
    const toAnn = notifier.events.find((entry) => entry.userId === "ann")!.event as any;
    assert.equal(toAnn.kind, "friendly_match");
    assert.equal(toAnn.roomId, accepted.match.roomId);
    assert.equal(matches.rows[0].status, "accepted");
    assert.equal((await service.list("ann")).match?.roomId, accepted.match.roomId);
  });

  it("asking again answers the pending challenge, the other direction is offered back, a new target cancels the old one", async () => {
    const { service, notifier, befriend } = setup();
    befriend("ann", "bob");
    befriend("ann", "cid");
    const first = await service.send("ann", "bob");
    notifier.clear();
    assert.equal((await service.send("ann", "bob")).challenge.challengeId, first.challenge.challengeId);
    assert.equal(notifier.events.length, 0);

    const back = await service.send("bob", "ann");
    assert.equal(back.challenge.challengeId, first.challenge.challengeId);
    assert.equal(back.challenge.direction, "incoming");

    await service.send("ann", "cid");
    assert.deepEqual(notifier.kinds("bob"), ["friendly_challenge_cancelled"]);
    assert.equal((await service.list("bob")).incoming.length, 0);
  });

  it("only friends (or guild mates when allowed), online and not busy", async () => {
    const { service, repo, battles, befriend } = setup();
    await assert.rejects(service.send("ann", "bob"), isError("FRIENDLY_NOT_ALLOWED"));
    befriend("ann", "bob");
    repo.connections.set("bob", { online: false, lastSeenAt: new Date(T0 - 600_000) });
    await assert.rejects(service.send("ann", "bob"), isError("FRIENDLY_TARGET_OFFLINE"));
    repo.connections.set("bob", { online: true, lastSeenAt: new Date(T0) });
    battles.live.add("bob");
    await assert.rejects(service.send("ann", "bob"), isError("FRIENDLY_TARGET_BUSY"));
    battles.live.delete("bob");
    battles.live.add("ann");
    await assert.rejects(service.send("ann", "bob"), isError("FRIENDLY_BUSY"));
    battles.live.delete("ann");
    repo.blocks.push({ blockerId: "bob", blockedId: "ann", createdAt: new Date(T0) });
    await assert.rejects(service.send("ann", "bob"), isError("FRIENDLY_NOT_ALLOWED"));

    const guild = setup({ allowGuildMembers: true });
    guild.repo.guilds.set("ann", { guildId: "g", guildName: "G" });
    guild.repo.guilds.set("cid", { guildId: "g", guildName: "G" });
    assert.equal((await guild.service.send("ann", "cid")).challenge.direction, "outgoing");
    await assert.rejects(setup({ allowGuildMembers: false }).service.send("ann", "cid"), isError("FRIENDLY_NOT_ALLOWED"));
  });

  it("only the target accepts or declines, only the challenger cancels; expired challenges are refused", async () => {
    const { service, notifier, befriend, clock } = setup({ challengeTtlSeconds: 30 });
    befriend("ann", "bob");
    const { challenge } = await service.send("ann", "bob");
    await assert.rejects(service.accept("ann", challenge.challengeId), isError("FRIENDLY_CHALLENGE_NOT_FOUND"));
    await assert.rejects(service.accept("cid", challenge.challengeId), isError("FRIENDLY_CHALLENGE_NOT_FOUND"));
    await assert.rejects(service.cancel("bob", challenge.challengeId), isError("FRIENDLY_CHALLENGE_NOT_FOUND"));

    notifier.clear();
    await service.decline("bob", challenge.challengeId);
    assert.deepEqual(notifier.kinds("ann"), ["friendly_challenge_declined"]);
    await assert.rejects(service.accept("bob", challenge.challengeId), isError("FRIENDLY_CHALLENGE_NOT_FOUND"));

    const second = await service.send("ann", "bob");
    clock.advance(31_000);
    await assert.rejects(service.accept("bob", second.challenge.challengeId), isError("FRIENDLY_CHALLENGE_EXPIRED"));

    const third = await service.send("ann", "bob");
    notifier.clear();
    await service.cancel("ann", third.challenge.challengeId);
    assert.deepEqual(notifier.kinds("bob"), ["friendly_challenge_cancelled"]);
  });

  it("a room that refuses (busy player) aborts the match and tells both", async () => {
    const { service, notifier, befriend, rooms, matches } = setup();
    befriend("ann", "bob");
    const { challenge } = await service.send("ann", "bob");
    rooms.fail = new FriendlyRoomBusyError("ann");
    notifier.clear();
    await assert.rejects(service.accept("bob", challenge.challengeId), isError("FRIENDLY_TARGET_BUSY"));
    assert.equal(matches.rows[0].status, "aborted");
    assert.deepEqual(notifier.kinds("ann"), ["friendly_match_aborted"]);
  });

  it("records the end once, and a block cancels pending challenges", async () => {
    const { service, notifier, befriend } = setup();
    befriend("ann", "bob");
    const { challenge } = await service.send("ann", "bob");
    const { match } = await service.accept("bob", challenge.challengeId);
    assert.equal(await service.matchEnded(match.matchId, { status: "finished", winnerId: "bob", reason: "elimination" }), true);
    assert.equal(await service.matchEnded(match.matchId, { status: "aborted", winnerId: null, reason: "room_closed" }), false);
    assert.equal(await service.matchForRoom(match.matchId), null, "a finished match cannot get a room");

    const next = await service.send("ann", "bob");
    notifier.clear();
    await service.cancelBetween("bob", "ann");
    assert.deepEqual(notifier.kinds("ann"), ["friendly_challenge_declined"]);
    await assert.rejects(service.accept("bob", next.challenge.challengeId), isError("FRIENDLY_CHALLENGE_NOT_FOUND"));
  });
  it("aborts an accepted match whose room is gone (server restart) instead of offering a rejoin", async () => {
    const { service, befriend, rooms, matches } = setup();
    befriend("ann", "bob");
    const sent = await service.send("ann", "bob");
    const accepted = await service.accept("bob", sent.challenge.challengeId);
    assert.equal((await service.list("ann")).match?.roomId, accepted.match.roomId);

    rooms.gone.add(accepted.match.roomId);
    assert.equal((await service.list("ann")).match, null);
    assert.equal(matches.rows[0].status, "aborted");
    assert.equal((await service.list("bob")).match, null);
  });
});
