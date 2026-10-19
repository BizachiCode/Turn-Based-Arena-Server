import assert from "node:assert/strict";
import { LocalPresence } from "@colyseus/core";

import { ActiveBattleRegistry, type ActiveBattleStore } from "../src/shared/rooms/active-battles";

describe("ActiveBattleRegistry", () => {
  function setup(nowMs = 1_700_000_000_000) {
    const presence = new LocalPresence();
    const liveRooms = new Set<string>(["room-a", "room-b"]);
    const registry = new ActiveBattleRegistry(() => presence as unknown as ActiveBattleStore, (roomId) => liveRooms.has(roomId), () => nowMs);
    return { presence, liveRooms, registry };
  }

  it("gives one battle slot per player and reports the battle that holds it", async () => {
    const { registry } = setup();
    assert.deepEqual(await registry.claim("u1", "room-a", "pve"), { ok: true, active: null });
    await registry.attachBattle("u1", "room-a", "B1");

    const refused = await registry.claim("u1", "room-b", "arena");
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.active, { roomId: "room-a", battleId: "B1", mode: "pve", sinceUnix: 1_700_000_000 });

    // Same room again (a new battle after the previous one finished) keeps the slot.
    assert.equal((await registry.claim("u1", "room-a", "pve")).ok, true);
    // Other players are independent.
    assert.equal((await registry.claim("u2", "room-b", "arena")).ok, true);
    assert.equal((await registry.find("u2"))?.mode, "arena");
  });

  it("clears a zombie entry whose room no longer exists", async () => {
    const { registry, liveRooms } = setup();
    await registry.claim("u1", "room-a", "pve");
    liveRooms.delete("room-a");

    assert.equal(await registry.find("u1"), null);
    assert.equal((await registry.claim("u1", "room-b", "pve")).ok, true);
    assert.equal((await registry.find("u1"))?.roomId, "room-b");
  });

  it("refuses a second claim of the same player while one is in flight", async () => {
    const { registry, presence } = setup();
    await presence.incr("battle:claim:u1");
    assert.deepEqual(await registry.claim("u1", "room-a", "pve"), { ok: false, active: null });
    presence.del("battle:claim:u1");
    assert.equal((await registry.claim("u1", "room-a", "pve")).ok, true);
  });

  it("only the room holding the slot releases it", async () => {
    const { registry } = setup();
    await registry.claim("u1", "room-a", "pve");
    await registry.release("u1", "room-b");
    assert.equal((await registry.find("u1"))?.roomId, "room-a");
    await registry.attachBattle("u1", "room-b", "ignored");
    assert.equal((await registry.find("u1"))?.battleId, null);

    await registry.release("u1", "room-a");
    assert.equal(await registry.find("u1"), null);
  });

  it("looks up several players at once and fails open when the driver throws", async () => {
    const presence = new LocalPresence();
    const registry = new ActiveBattleRegistry(() => presence as unknown as ActiveBattleStore, () => { throw new Error("driver down"); });
    await registry.claim("u1", "room-a", "pvp");
    const found = await registry.findMany(["u1", "u2"]);
    assert.deepEqual([...found.keys()], ["u1"]);
    assert.equal(found.get("u1")?.mode, "pvp");
  });
});
