import assert from "node:assert/strict";

import { registerRevocationHandler, USER_REVOKED_TOPIC } from "../src/shared/rooms/user-revocation";

function fakePresence() {
  const listeners = new Map<string, Array<(raw: unknown) => void>>();
  let subscribes = 0;
  let unsubscribes = 0;
  return {
    subscribe(topic: string, callback: (raw: unknown) => void) {
      subscribes++;
      listeners.set(topic, [...(listeners.get(topic) ?? []), callback]);
    },
    unsubscribe(topic: string, callback?: (raw: unknown) => void) {
      unsubscribes++;
      listeners.set(topic, (listeners.get(topic) ?? []).filter((current) => current !== callback));
    },
    publish(topic: string, raw: unknown) {
      for (const callback of listeners.get(topic) ?? []) callback(raw);
    },
    counts: () => ({ subscribes, unsubscribes, listeners: (listeners.get(USER_REVOKED_TOPIC) ?? []).length }),
  };
}

describe("User revocation hub", () => {
  it("shares one presence subscription between every room and reaches all of them", () => {
    const presence = fakePresence();
    const received: number[] = [];
    const unregister = Array.from({ length: 50 }, (_, index) => registerRevocationHandler(presence, () => received.push(index)));
    assert.deepEqual(presence.counts(), { subscribes: 1, unsubscribes: 0, listeners: 1 });

    presence.publish(USER_REVOKED_TOPIC, JSON.stringify({ userId: "u1" }));
    assert.equal(received.length, 50);

    unregister.slice(0, 49).forEach((drop) => drop());
    assert.equal(presence.counts().unsubscribes, 0, "still one room listening");
    unregister[49]();
    unregister[49](); // idempotent
    assert.deepEqual(presence.counts(), { subscribes: 1, unsubscribes: 1, listeners: 0 });
  });

  it("a failing room never stops the others and a new room resubscribes after the last one left", () => {
    const presence = fakePresence();
    let reached = 0;
    const dropFailing = registerRevocationHandler(presence, () => { throw new Error("boom"); });
    const dropOk = registerRevocationHandler(presence, () => { reached++; });
    presence.publish(USER_REVOKED_TOPIC, "{}");
    assert.equal(reached, 1);

    dropFailing();
    dropOk();
    const dropAgain = registerRevocationHandler(presence, () => { reached++; });
    assert.equal(presence.counts().subscribes, 2);
    presence.publish(USER_REVOKED_TOPIC, "{}");
    assert.equal(reached, 2);
    dropAgain();
  });
});
