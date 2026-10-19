import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error";
import { FriendsService } from "../src/modules/social/friends.service";
import { socialConfig, socialKit, T0 } from "./support/social-fakes";

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

function setup(friends: Parameters<typeof socialConfig>[0]["friends"] = {}) {
  const kit = socialKit(socialConfig({ friends }));
  const blockedHook: string[] = [];
  const service = new FriendsService({
    friends: kit.repo,
    directory: kit.repo,
    status: kit.status,
    notifier: kit.notifier,
    uow: kit.uow,
    clock: kit.clock,
    config: kit.config,
    newId: kit.newId,
    unread: { unreadByPeer: async (userId) => new Map(userId === "bob" ? [["ann", 3]] : []) },
    onBlocked: (blocker, blocked) => { blockedHook.push(`${blocker}>${blocked}`); },
  });
  for (const [id, name] of [["ann", "Annabel"], ["bob", "Bobby"], ["cid", "Cidra"], ["dan", "Daniel"]]) kit.repo.addPlayer(id, name);
  return { ...kit, service, blockedHook };
}

describe("Friends service", () => {
  it("sends a request by id or name, pushes it, and the target accepts", async () => {
    const { service, notifier, repo } = setup();
    const sent = await service.request("ann", { name: "bobby" });
    assert.equal(sent.relation, "pending_out");
    assert.equal(sent.player.userId, "bob");
    assert.deepEqual(notifier.kinds("bob"), ["friend_request"]);
    const pushed = notifier.events[0].event as any;
    assert.equal(pushed.request.player.userId, "ann");
    assert.equal(pushed.request.player.relation, "pending_in");

    // Asking again answers the same pending request without a second push.
    const again = await service.request("ann", { targetUserId: "bob" });
    assert.equal(again.requestId, sent.requestId);
    assert.equal(notifier.events.length, 1);

    const requests = await service.requests("bob");
    assert.deepEqual(requests.incoming.map((entry) => entry.player.userId), ["ann"]);
    assert.equal((await service.summary("bob")).incomingRequests, 1);

    const accepted = await service.accept("bob", sent.requestId);
    assert.equal(accepted.friend?.userId, "ann");
    assert.equal(accepted.friend?.unread, 3);
    assert.deepEqual(notifier.kinds("ann"), ["friend_accepted"]);
    assert.equal(repo.rows[0].status, "accepted");

    const list = await service.list("ann");
    assert.deepEqual(list.friends.map((friend) => friend.userId), ["bob"]);
    assert.equal(list.friends[0].friendsSinceUnix, Math.floor(T0 / 1000));
  });

  it("a request towards someone who already asked becomes a friendship", async () => {
    const { service, notifier } = setup();
    await service.request("ann", { targetUserId: "bob" });
    notifier.clear();
    const crossed = await service.request("bob", { targetUserId: "ann" });
    assert.equal(crossed.relation, "friend");
    assert.deepEqual(notifier.kinds("ann"), ["friend_accepted"]);
    assert.equal(await service.areFriends("ann", "bob"), true);
    await assert.rejects(service.request("ann", { targetUserId: "bob" }), isError("FRIEND_ALREADY"));
  });

  it("only the addressee accepts / rejects and only the requester cancels (no BOLA by request id)", async () => {
    const { service, notifier } = setup();
    const { requestId } = await service.request("ann", { targetUserId: "bob" });
    await assert.rejects(service.accept("ann", requestId), isError("FRIEND_REQUEST_NOT_FOUND"));
    await assert.rejects(service.accept("cid", requestId), isError("FRIEND_REQUEST_NOT_FOUND"));
    await assert.rejects(service.cancel("bob", requestId), isError("FRIEND_REQUEST_NOT_FOUND"));
    await assert.rejects(service.reject("ann", requestId), isError("FRIEND_REQUEST_NOT_FOUND"));

    notifier.clear();
    await service.reject("bob", requestId);
    assert.deepEqual(notifier.kinds("ann"), ["friend_request_removed"]);
    await assert.rejects(service.accept("bob", requestId), isError("FRIEND_REQUEST_NOT_FOUND"));

    const second = await service.request("ann", { targetUserId: "bob" });
    notifier.clear();
    await service.cancel("ann", second.requestId);
    assert.deepEqual(notifier.kinds("bob"), ["friend_request_removed"]);
  });

  it("enforces the outgoing and incoming request limits", async () => {
    const { service } = setup({ maxPendingOutgoing: 1, maxPendingIncoming: 1 });
    await service.request("ann", { targetUserId: "bob" });
    await assert.rejects(service.request("ann", { targetUserId: "cid" }), isError("FRIEND_TOO_MANY_REQUESTS"));
    await assert.rejects(service.request("cid", { targetUserId: "bob" }), isError("FRIEND_TARGET_REQUESTS_FULL"));
  });

  it("enforces the friends list size of both players, also when accepting", async () => {
    const { service } = setup({ maxFriends: 1 });
    const toBob = await service.request("ann", { targetUserId: "bob" });
    const toDan = await service.request("ann", { targetUserId: "dan" });
    const fromCid = await service.request("cid", { targetUserId: "ann" });
    await service.accept("bob", toBob.requestId);

    await assert.rejects(service.request("ann", { targetUserId: "cid" }), isError("FRIEND_LIST_FULL"), "auto-accept of cid's request");
    await assert.rejects(service.accept("ann", fromCid.requestId), isError("FRIEND_LIST_FULL"));
    await assert.rejects(service.accept("dan", toDan.requestId), isError("FRIEND_TARGET_LIST_FULL"));
    await assert.rejects(service.request("dan", { targetUserId: "bob" }).then(() => service.request("bob", { targetUserId: "dan" })), isError("FRIEND_LIST_FULL"));
  });

  it("removes a friend and tells them", async () => {
    const { service, notifier } = setup();
    const { requestId } = await service.request("ann", { targetUserId: "bob" });
    await service.accept("bob", requestId);
    notifier.clear();
    await service.remove("bob", "ann");
    assert.deepEqual(notifier.kinds("ann"), ["friend_removed"]);
    assert.equal(await service.areFriends("ann", "bob"), false);
    await assert.rejects(service.remove("bob", "ann"), isError("FRIEND_NOT_FOUND"));
  });

  it("blocking drops the friendship, refuses requests both ways and runs the hook", async () => {
    const { service, notifier, blockedHook } = setup();
    const { requestId } = await service.request("ann", { targetUserId: "bob" });
    await service.accept("bob", requestId);
    notifier.clear();

    await service.block("bob", "ann");
    assert.deepEqual(notifier.kinds("ann"), ["friend_removed"]);
    assert.deepEqual(blockedHook, ["bob>ann"]);
    assert.equal(await service.isBlockedEitherWay("ann", "bob"), true);
    await assert.rejects(service.request("ann", { targetUserId: "bob" }), isError("FRIEND_REQUEST_REFUSED"));
    await assert.rejects(service.request("bob", { targetUserId: "ann" }), isError("PLAYER_BLOCKED"));
    assert.deepEqual((await service.blocked("bob")).players.map((player) => player.userId), ["ann"]);

    const search = await service.search("bob", "Ann");
    assert.equal(search.players[0].relation, "blocked");

    await service.unblock("bob", "ann");
    assert.equal(await service.isBlockedEitherWay("ann", "bob"), false);
    assert.equal((await service.request("ann", { targetUserId: "bob" })).relation, "pending_out");
    await assert.rejects(service.block("bob", "bob"), isError("SOCIAL_SELF"));
  });

  it("searches by name prefix with relations and status, and shows public profiles", async () => {
    const { service, repo, battles, clock } = setup({ searchMinChars: 2 });
    repo.addPlayer("ann2", "Anna");
    repo.connections.set("ann", { online: true, lastSeenAt: new Date(T0) });
    repo.connections.set("ann2", { online: false, lastSeenAt: new Date(T0 - 3600_000) });
    battles.live.add("bob");
    repo.guilds.set("ann", { guildId: "g1", guildName: "Dragons" });
    repo.arena.set("ann", { rating: 1234, wins: 5, losses: 2 });
    await service.request("bob", { targetUserId: "ann" });

    assert.deepEqual((await service.search("bob", "a")).players, [], "below the minimum length");
    const found = await service.search("bob", "An");
    assert.deepEqual(found.players.map((player) => [player.userId, player.relation, player.status]), [
      ["ann2", "none", "offline"],
      ["ann", "pending_out", "online"],
    ]);
    assert.equal(found.players[0].lastSeenUnix, Math.floor((T0 - 3600_000) / 1000));
    assert.equal((await service.search("bob", "Bob")).players[0].relation, "self");

    const profile = await service.profile("cid", "ann");
    assert.equal(profile.guildName, "Dragons");
    assert.deepEqual(profile.arena, { rating: 1234, wins: 5, losses: 2 });
    assert.equal(profile.player.relation, "none");
    const busy = await service.profile("ann", "bob");
    assert.equal(busy.player.status, "in_battle");
    await assert.rejects(service.profile("ann", "nobody"), isError("PLAYER_NOT_FOUND"));
    void clock;
  });

  it("refuses everything when friends are disabled, and self requests", async () => {
    const { service } = setup();
    await assert.rejects(service.request("ann", { targetUserId: "ann" }), isError("SOCIAL_SELF"));
    await assert.rejects(service.request("ann", { targetUserId: "ghost" }), isError("PLAYER_NOT_FOUND"));
    const disabled = setup({ enabled: false });
    await assert.rejects(disabled.service.list("ann"), isError("FRIENDS_DISABLED"));
  });
});
