import assert from "node:assert/strict";

import { InMemoryCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import { VersionedCache } from "../src/shared/kernel/versioned-cache";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RosterService } from "../src/modules/roster/roster.service";
import { RuneCache } from "../src/modules/rune/rune.cache";
import type { RuneGenerator } from "../src/modules/rune/rune.generator";
import type { RuneRepository, RuneRules } from "../src/modules/rune/rune.ports";
import { RuneService } from "../src/modules/rune/rune.service";
import { currencyRulesOf, InMemoryCharacterRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";

describe("VersionedCache", () => {
  it("hides an entry written with a token that was bumped meanwhile", async () => {
    const cache = new VersionedCache(new InMemoryCache(), "t_ver");
    const token = await cache.token("u1");
    await cache.bump("u1", "k");
    await cache.set("k", "stale", 60, token); // late write of a reader that started before the mutation
    assert.equal(await cache.get("k", "u1"), null);

    const fresh = await cache.token("u1");
    await cache.set("k", "fresh", 60, fresh);
    assert.equal(await cache.get("k", "u1"), "fresh");
    await cache.bump("u1", "k");
    assert.equal(await cache.get("k", "u1"), null);
  });
});

describe("Roster cache: stale write after a concurrent mutation", () => {
  it("does not serve the page that was read before the mutation committed", async () => {
    const wallets = new InMemoryWalletRepository();
    const characters = new InMemoryCharacterRepository();
    const uow = new InMemoryUnitOfWork().register(wallets).register(characters);
    const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "gold" }]), new FixedClock(0));
    const progression = new MonsterProgression({
      starTiers: () => [], powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
      evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
    });
    const cache = new RosterCache(new InMemoryCache());
    const roster = new RosterService(characters, cache, ledger, progression, () => ({ bagCapacity: 10, storageCapacity: 10 }), uow);
    characters.add(USER, { uid: "A", characterId: "c1" });

    // A mutation commits and invalidates while the list is between its database read and its cache write.
    const listByLocation = characters.listByLocation.bind(characters);
    let raced = false;
    characters.listByLocation = async (...args: Parameters<typeof listByLocation>) => {
      const stale = await listByLocation(...args);
      if (!raced) {
        raced = true;
        characters.add(USER, { uid: "B", characterId: "c1" });
        await cache.invalidate(USER);
      }
      return stale;
    };

    const first = await roster.listRoster(USER, 0, 50);
    assert.deepEqual(first.items.map((item) => item.uid), ["A"], "the racing reader itself saw the old data");

    const second = await roster.listRoster(USER, 0, 50);
    assert.deepEqual(second.items.map((item) => item.uid).sort(), ["A", "B"], "the stale page was not cached");
    assert.equal(second.total, 2);

    // Without a race the page is cached normally.
    characters.add(USER, { uid: "C", characterId: "c1" });
    const cached = await roster.listRoster(USER, 0, 50);
    assert.equal(cached.total, 2, "served from cache until the next invalidation");
    await cache.invalidate(USER);
    assert.equal((await roster.listRoster(USER, 0, 50)).total, 3);
  });
});

describe("Rune cache: stale write after a concurrent mutation", () => {
  it("does not keep set counts that were read before the mutation", async () => {
    const cache = new RuneCache(new InMemoryCache());
    let free = 1;
    const runes = {
      freeCountsBySet: async () => {
        const snapshot = free;
        if (snapshot === 1) {
          free = 2; // a rune is granted and committed while we are reading
          await cache.invalidate(USER);
        }
        return [{ setId: "Energy", count: snapshot }];
      },
    } as unknown as RuneRepository;
    const service = new RuneService(runes, {} as RuneGenerator, {} as RuneRules, {} as WalletLedger, cache, new InMemoryUnitOfWork());

    assert.deepEqual(await service.setCounts(USER), [{ setId: "Energy", freeCount: 1 }]);
    assert.deepEqual(await service.setCounts(USER), [{ setId: "Energy", freeCount: 2 }], "stale counts were not cached");
    assert.deepEqual(await service.setCounts(USER), [{ setId: "Energy", freeCount: 2 }]);
  });
});
