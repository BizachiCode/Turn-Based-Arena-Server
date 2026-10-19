import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { createSeededRandom } from "../src/shared/kernel/random";
import { AppError } from "../src/shared/errors/app-error";
import type { CharacterDTO } from "../src/config/DTO/characterCatalogDto";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { CharacterGrantService } from "../src/modules/roster/character-grant.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { SummonService } from "../src/modules/summon/summon.service";
import { AwakeningService } from "../src/modules/awakening/awakening.service";
import { currencyRulesOf, InMemoryCharacterRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";

const definitions: Record<string, Partial<CharacterDTO>> = {
  hero: {
    id: "hero",
    naturalStars: 3,
    skillIds: ["s1", "s2"],
    awakenings: [{ minLevel: 10, minStars: 3, costs: [{ currencyId: "essence", amount: 5 }, { currencyId: "essence", amount: 5 }] } as any],
  },
};
const characterRules = { get: (id: string) => definitions[id] as CharacterDTO | undefined };

function setup() {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(characters);
  const currencies = currencyRulesOf([{ id: "mystic_scroll" }, { id: "single_scroll" }, { id: "essence" }]);
  const ledger = new WalletLedger(wallets, currencies, new FixedClock(0));
  const progression = new MonsterProgression({
    starTiers: () => [{ stars: 3, maxLevel: 35, expPerLevel: [] }],
    powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
    evolve: () => ({ currencyId: "gold", costPerStarUnit: 0, steps: [] }),
  });
  const grants = new CharacterGrantService(characters, characterRules, progression, () => characters.capacity);
  const scrolls = {
    get: (id: string) => ({
      mystic_scroll: { id: "mystic_scroll", minStars: 3, maxStars: 3, currencyId: "mystic_scroll", costPerSummon: 1, tenPlusOneCost: 10, pools: [{ id: "p", weight: 1, minStars: 3, maxStars: 3, entries: [{ characterId: "hero", weight: 1 }] }] },
      single_scroll: { id: "single_scroll", minStars: 3, maxStars: 3, currencyId: "single_scroll", costPerSummon: 1, multiGive: 1, pools: [{ id: "p", weight: 1, minStars: 3, maxStars: 3, entries: [{ characterId: "hero", weight: 1 }] }] },
    } as any)[id],
  };
  const summons = new SummonService(scrolls, currencies, characterRules, grants, ledger, new RosterCache(noCache), createSeededRandom(7), uow);
  const awakening = new AwakeningService(characters, characterRules, ledger, new RosterCache(noCache), uow);
  return { wallets, characters, summons, awakening };
}

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

describe("SummonService", () => {
  it("charges the 10+1 price and grants 11 characters", async () => {
    const { wallets, characters, summons } = setup();
    characters.capacity = { bagCapacity: 20, storageCapacity: 0 };
    wallets.set(USER, "mystic_scroll", 12);

    const result = await summons.summon(USER, { scrollId: "mystic_scroll", multi: true, target: "BAG" });
    assert.equal(result.grants.length, 11);
    assert.equal(result.grants[0].stars, 3);
    assert.deepEqual(result.grants[0].skillLevels, [1, 1]);
    assert.equal(wallets.amount(USER, "mystic_scroll"), 2);
  });

  it("rejects summons that don't fit, can't be paid, or have no 10+1 offer", async () => {
    const { wallets, characters, summons } = setup();
    characters.capacity = { bagCapacity: 5, storageCapacity: 0 };
    wallets.set(USER, "mystic_scroll", 12);
    wallets.set(USER, "single_scroll", 12);

    await assert.rejects(summons.summon(USER, { scrollId: "mystic_scroll", multi: true, target: "BAG" }), isError("ROSTER_FULL"));
    await assert.rejects(summons.summon(USER, { scrollId: "single_scroll", multi: true, target: "BAG" }), isError("INVALID_REQUEST"));
    wallets.set(USER, "mystic_scroll", 0);
    await assert.rejects(summons.summon(USER, { scrollId: "mystic_scroll", multi: false, target: "BAG" }), isError("NOT_ENOUGH_SCROLLS"));
    assert.equal(characters.records.size, 0);
  });
});

describe("AwakeningService", () => {
  it("checks requirements, previews without spending and charges merged costs", async () => {
    const { wallets, characters, awakening } = setup();
    characters.add(USER, { uid: "H", characterId: "hero", stars: 3, level: 5 });
    wallets.set(USER, "essence", 10);

    await assert.rejects(awakening.awaken(USER, "H", false), (error: unknown) => error instanceof AppError && error.errorCode === "REQUIREMENT_LEVEL" && error.fields?.requiredLevel === 10);

    characters.records.get("H")!.level = 10;
    const preview = await awakening.awaken(USER, "H", true);
    assert.deepEqual(preview, { ok: true, preview: true, needs: [{ currencyId: "essence", need: 10, have: 10, missing: 0 }] });
    assert.equal(wallets.amount(USER, "essence"), 10);

    const result = await awakening.awaken(USER, "H", false);
    assert.equal(result.ok, true);
    assert.equal(wallets.amount(USER, "essence"), 0);
    assert.equal(characters.records.get("H")!.awakeningIndex, 1);
    await assert.rejects(awakening.awaken(USER, "H", false), isError("NO_MORE_AWAKENINGS"));
  });
});
