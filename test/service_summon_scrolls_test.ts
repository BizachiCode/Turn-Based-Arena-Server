import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { createSeededRandom } from "../src/shared/kernel/random";
import { AppError } from "../src/shared/errors/app-error";
import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";
import { isSummonScrollAvailable, type SummonScroll } from "../src/config/SummonCatalog";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { CharacterGrantService } from "../src/modules/roster/character-grant.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { SummonService } from "../src/modules/summon/summon.service";
import { currencyRulesOf, InMemoryCharacterRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";
const NOW = Date.UTC(2026, 9, 15, 12);

// Light / Dark only from their own scroll; the Mystic scroll keeps Fire / Water / Ground.
const roster: Record<string, { element: string; naturalStars: number }> = {
  imp_fire: { element: "fire", naturalStars: 3 },
  yeti_water: { element: "water", naturalStars: 4 },
  dragon_ground: { element: "ground", naturalStars: 5 },
  imp_light: { element: "light", naturalStars: 3 },
  imp_dark: { element: "dark", naturalStars: 3 },
  yeti_light: { element: "light", naturalStars: 4 },
  dragon_dark: { element: "dark", naturalStars: 5 },
};
const characterRules = {
  get: (id: string) => (roster[id] ? ({ id, skillIds: ["s1"], ...roster[id] } as unknown as CharacterDTO) : undefined),
};

const pool = (id: string, weight: number, stars: number, ids: string[]) => ({
  id, weight, minStars: stars, maxStars: stars, entries: ids.map((characterId) => ({ characterId, weight: 1 })),
});

const lightDark: SummonScroll = {
  id: "light_dark_scroll",
  currencyId: "light_dark_scroll_cur",
  costPerSummon: 1,
  tenPlusOneCost: 10,
  pools: [pool("ld_nat3", 935, 3, ["imp_light", "imp_dark"]), pool("ld_nat4", 60, 4, ["yeti_light"]), pool("ld_nat5", 5, 5, ["dragon_dark"])],
};
const mystic: SummonScroll = {
  id: "mystic_scroll",
  currencyId: "mystic_scroll_cur",
  costPerSummon: 1,
  tenPlusOneCost: 10,
  pools: [pool("nat3", 915, 3, ["imp_fire"]), pool("nat4", 80, 4, ["yeti_water"]), pool("nat5", 5, 5, ["dragon_ground"])],
};
const banner: SummonScroll = {
  ...lightDark,
  id: "event_banner",
  availableFromUnix: NOW / 1000,
  availableUntilUnix: NOW / 1000 + 7 * 86_400,
};

/** Summons per user and scroll (rolled back with the transaction). */
class InMemorySummonCounters {
  rows = new Map<string, number>();
  async count(userId: string, scrollId: string) { return this.rows.get(`${userId}|${scrollId}`) ?? 0; }
  async add(userId: string, scrollId: string, amount: number) {
    const key = `${userId}|${scrollId}`;
    this.rows.set(key, (this.rows.get(key) ?? 0) + amount);
  }
  snapshot() { return new Map(this.rows); }
  restore(state: unknown) { this.rows = state as Map<string, number>; }
}

function setup(seed = 3, guaranteed: Record<string, string[]> = {}) {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  characters.capacity = { bagCapacity: 5000, storageCapacity: 0 };
  const counters = new InMemorySummonCounters();
  const uow = new InMemoryUnitOfWork().register(wallets).register(characters).register(counters);
  const currencies = currencyRulesOf([{ id: "light_dark_scroll_cur" }, { id: "mystic_scroll_cur" }]);
  const clock = new FixedClock(NOW);
  const ledger = new WalletLedger(wallets, currencies, clock);
  const progression = new MonsterProgression({
    starTiers: () => [3, 4, 5].map((stars) => ({ stars, maxLevel: 40, expPerLevel: [] })),
    powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
  });
  const grants = new CharacterGrantService(characters, characterRules, progression, () => characters.capacity);
  const scrolls = {
    get: (id: string) => [lightDark, mystic, banner].find((scroll) => scroll.id === id),
    guaranteed: (id: string) => guaranteed[id] ?? [],
  };
  const summons = new SummonService(scrolls, currencies, characterRules, grants, ledger, new RosterCache(noCache), createSeededRandom(seed), uow, undefined, clock, counters);
  return { wallets, summons, clock, counters };
}

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

describe("Summon scroll pools", () => {
  it("the Light & Darkness scroll only grants light / dark monsters with special-scroll star rates", async function () {
    this.timeout(20_000);
    const { wallets, summons } = setup();
    wallets.set(USER, "light_dark_scroll_cur", 3000);
    const stars = new Map<number, number>();
    let total = 0;
    for (let i = 0; i < 300; i++) {
      for (const grant of (await summons.summon(USER, { scrollId: "light_dark_scroll", multi: true, target: "BAG" })).grants) {
        assert.ok(["light", "dark"].includes(roster[grant.characterId].element), grant.characterId);
        assert.equal(grant.stars, roster[grant.characterId].naturalStars, "natural stars");
        stars.set(grant.stars, (stars.get(grant.stars) ?? 0) + 1);
        total++;
      }
    }
    assert.equal(total, 3300, "10+1");
    assert.ok(Math.abs((stars.get(3) ?? 0) / total - 0.935) < 0.02);
    assert.ok(Math.abs((stars.get(4) ?? 0) / total - 0.06) < 0.015);
    assert.equal(wallets.amount(USER, "light_dark_scroll_cur"), 0);
  });

  it("the Mystic scroll never grants light / dark monsters", async () => {
    const { wallets, summons } = setup(11);
    wallets.set(USER, "mystic_scroll_cur", 110);
    for (let i = 0; i < 10; i++) {
      const result = await summons.summon(USER, { scrollId: "mystic_scroll", multi: true, target: "BAG" });
      assert.equal(result.grants.length, 11);
      for (const grant of result.grants) assert.ok(!["light", "dark"].includes(roster[grant.characterId].element));
    }
  });

  it("the first summons of a scroll give the tutorial guaranteed monsters in order, then roll", async () => {
    const { wallets, summons, counters } = setup(5, { mystic_scroll: ["imp_dark", "dragon_dark"] });
    wallets.set(USER, "mystic_scroll_cur", 13);
    const first = await summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG" });
    assert.deepEqual(first.grants.map((grant) => [grant.characterId, grant.stars]), [["imp_dark", 3]]);
    const multi = await summons.summon(USER, { scrollId: "mystic_scroll", multi: true, target: "BAG" });
    assert.equal(multi.grants[0].characterId, "dragon_dark", "the guarantee continues in a multi summon");
    assert.equal(multi.grants[0].stars, 5);
    for (const grant of multi.grants.slice(1)) assert.ok(!["light", "dark"].includes(roster[grant.characterId].element), "then the pools roll");
    assert.equal(counters.rows.get(`${USER}|mystic_scroll`), 12);
    const later = await summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG" });
    assert.ok(!["light", "dark"].includes(roster[later.grants[0].characterId].element));
  });

  it("a failed summon does not use up a guaranteed monster", async () => {
    const { summons, counters } = setup(5, { mystic_scroll: ["imp_dark"] });
    await assert.rejects(summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG" }), isError("NOT_ENOUGH_SCROLLS"));
    assert.equal(counters.rows.get(`${USER}|mystic_scroll`) ?? 0, 0);
  });

  it("banner scrolls only summon inside their date window", async () => {
    const { wallets, summons, clock } = setup();
    wallets.set(USER, "light_dark_scroll_cur", 5);
    assert.equal(isSummonScrollAvailable(banner, NOW - 1), false);
    assert.equal(isSummonScrollAvailable(banner, NOW), true);
    assert.equal(isSummonScrollAvailable(lightDark, 0), true, "no window = always");

    assert.equal((await summons.summon(USER, { scrollId: "event_banner", multi: false, target: "BAG" })).grants.length, 1);
    clock.advance(7 * 86_400_000);
    await assert.rejects(summons.summon(USER, { scrollId: "event_banner", multi: false, target: "BAG" }), isError("SCROLL_NOT_AVAILABLE"));
    assert.equal(wallets.amount(USER, "light_dark_scroll_cur"), 4, "nothing charged outside the window");
  });
});
