import assert from "node:assert/strict";

import { FixedClock } from "../src/shared/kernel/clock";
import { noCache } from "../src/shared/kernel/cache";
import { AppError } from "../src/shared/errors/app-error";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { MonsterProgression, type ProgressionRulesSource } from "../src/modules/progression/progression.rules";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RosterService } from "../src/modules/roster/roster.service";
import type { RosterRules, SkillUpRules } from "../src/modules/roster/roster.ports";
import { currencyRulesOf, InMemoryCharacterRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const USER = "user-1";

const rules: ProgressionRulesSource = {
  starTiers: () => [
    { stars: 1, maxLevel: 15, expPerLevel: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100] },
    { stars: 2, maxLevel: 20, expPerLevel: Array(19).fill(200) },
  ],
  powerUp: () => ({ currencyId: "gold", costPerFodderStarUnit: 100, expMultiplierByStars: [], minFodderBaseLevel: 2 }),
  evolve: () => ({ currencyId: "gold", costPerStarUnit: 50, steps: [{ fromStars: 1, toStars: 2, requiredStarPoints: 2 }] }),
};

/** c1: skills s1 (max 3) and s2 (max 2); devilmon is the skill-up material. */
const skillUps: SkillUpRules = {
  skills: (characterId) => (characterId === "c1" ? [{ id: "s1", maxLevel: 3 }, { id: "s2", maxLevel: 2 }] : [{ id: "x", maxLevel: 1 }]),
  isSkillUpMaterial: (characterId) => characterId === "devilmon",
};

const rosterRules: RosterRules = () => ({
  sell: { currencyId: "gold", priceByStars: [0, 100, 300], pricePerLevel: 10 },
  expansion: {
    bag: { step: 5, currencyId: "gold", costBase: 100, costIncrement: 50, initial: 10, max: 20 },
    storage: { step: 10, currencyId: "gold", costBase: 200, costIncrement: 0, initial: 10, max: 100 },
  },
});

function setup() {
  const wallets = new InMemoryWalletRepository();
  const characters = new InMemoryCharacterRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(characters);
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "gold" }]), new FixedClock(0));
  const progression = new MonsterProgression(rules);
  const roster = new RosterService(
    characters, new RosterCache(noCache), ledger, progression, () => ({ bagCapacity: 10, storageCapacity: 10 }), uow,
    undefined, skillUps, { int: () => 0, float: () => 0 },
    { rules: rosterRules, reserved: { reservedUids: async () => reserved } },
  );
  return { wallets, characters, roster, reserved };
}

const reserved = new Set<string>();

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

describe("RosterService", () => {
  it("powers up a unit, spends gold and consumes fodders", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1" });
    characters.add(USER, { uid: "F1", characterId: "c1" });
    characters.add(USER, { uid: "F2", characterId: "c1" });

    const result = await roster.powerUp(USER, "T", ["F1", "F2"]);
    assert.equal(result.expAdded, 200); // accumulated EXP to Lv.2 = 100 each
    assert.equal(result.newLevel, 3);
    assert.equal(result.priceSpent, 200);
    assert.equal(wallets.amount(USER, "gold"), 800);
    assert.equal(characters.records.has("F1"), false);
  });

  it("levels up one random unmaxed skill per same-monster or skill-up material fodder", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1", skillLevels: [1, 1] });
    characters.add(USER, { uid: "SAME", characterId: "c1" });
    characters.add(USER, { uid: "DEV", characterId: "devilmon" });
    characters.add(USER, { uid: "OTHER", characterId: "c9" });

    const result = await roster.powerUp(USER, "T", ["SAME", "DEV", "OTHER"]);
    assert.deepEqual(result.skillUps, [{ skillIndex: 0, skillId: "s1", level: 2 }, { skillIndex: 0, skillId: "s1", level: 3 }]);
    assert.deepEqual(result.skillLevels, [3, 1]);
    assert.deepEqual(characters.records.get("T")?.skillLevels, [3, 1]);
  });

  it("powers up a max-level monster only for skill-ups and stops at the max skill levels", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1", level: 15, skillLevels: [3, 1] });
    characters.add(USER, { uid: "F", characterId: "c9" });
    characters.add(USER, { uid: "D1", characterId: "devilmon" });
    characters.add(USER, { uid: "D2", characterId: "devilmon" });

    await assert.rejects(roster.powerUp(USER, "T", ["F"]), isError("ROSTER_AT_MAX_LEVEL"));
    const result = await roster.powerUp(USER, "T", ["D1", "D2"]);
    assert.deepEqual(result.skillUps, [{ skillIndex: 1, skillId: "s2", level: 2 }]);
    assert.deepEqual(result.skillLevels, [3, 2]);
    assert.equal(result.newLevel, 15);

    characters.add(USER, { uid: "D3", characterId: "devilmon" });
    await assert.rejects(roster.powerUp(USER, "T", ["D3"]), isError("ROSTER_AT_MAX_LEVEL"));
  });

  it("locks monsters: a locked monster can be powered up but not consumed or sold", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1" });
    characters.add(USER, { uid: "F", characterId: "c9" });
    assert.deepEqual(await roster.setLocked(USER, "T", true), { uid: "T", locked: true });
    assert.equal(characters.records.get("T")?.locked, true);
    await roster.powerUp(USER, "T", ["F"]);
    await assert.rejects(roster.sell(USER, ["T"]), isError("ROSTER_CHARACTER_LOCKED"));
    await assert.rejects(roster.setLocked(USER, "ghost", true), isError("ROSTER_CHARACTER_NOT_FOUND"));
  });

  it("sells monsters for gold by stars and level, all or nothing", async () => {
    const { wallets, characters, roster } = setup();
    characters.add(USER, { uid: "A", characterId: "c1", stars: 2, level: 5 });
    characters.add(USER, { uid: "B", characterId: "c1", stars: 1, level: 1, location: "STORAGE" });
    characters.add(USER, { uid: "R", characterId: "c1" });
    characters.equippedRuneOwners.add("R");

    await assert.rejects(roster.sell(USER, ["A", "R"]), isError("ROSTER_FODDER_HAS_RUNES"));
    assert.equal(characters.records.has("A"), true, "nothing sold");
    reserved.add("A");
    await assert.rejects(roster.sell(USER, ["A"]), isError("ROSTER_IN_DEFENSE"));
    reserved.clear();

    const result = await roster.sell(USER, ["A", "B"]);
    assert.equal(result.amount, 300 + 40 + 100);
    assert.equal(wallets.amount(USER, "gold"), 440);
    assert.equal(characters.records.has("A") || characters.records.has("B"), false);
  });

  it("buys bag slots with a growing price up to the maximum", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    const first = await roster.expand(USER, "BAG");
    assert.deepEqual([first.bagCapacity, first.priceSpent], [15, 100]);
    const second = await roster.expand(USER, "BAG");
    assert.deepEqual([second.bagCapacity, second.priceSpent], [20, 150]);
    await assert.rejects(roster.expand(USER, "BAG"), isError("ROSTER_CAPACITY_MAX"));
    assert.equal(wallets.amount(USER, "gold"), 750);
    assert.equal(characters.capacity.storageCapacity, 10);
  });

  it("does not consume arena defense monsters as fodder", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1" });
    characters.add(USER, { uid: "D", characterId: "c1" });
    reserved.add("D");
    await assert.rejects(roster.powerUp(USER, "T", ["D"]), isError("ROSTER_IN_DEFENSE"));
    reserved.clear();
  });

  it("rejects foreign, locked or rune-equipped fodders and rolls back", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1" });
    characters.add("someone-else", { uid: "X", characterId: "c1" });
    characters.add(USER, { uid: "L", characterId: "c1", locked: true });
    characters.add(USER, { uid: "R", characterId: "c1" });
    characters.equippedRuneOwners.add("R");

    await assert.rejects(roster.powerUp(USER, "T", ["X"]), isError("ROSTER_FODDER_NOT_FOUND"));
    await assert.rejects(roster.powerUp(USER, "T", ["L"]), isError("ROSTER_CHARACTER_LOCKED"));
    await assert.rejects(roster.powerUp(USER, "T", ["R"]), isError("ROSTER_FODDER_HAS_RUNES"));
    await assert.rejects(roster.powerUp(USER, "T", ["T"]), isError("ROSTER_CANNOT_CONSUME_TARGET"));
    assert.equal(wallets.amount(USER, "gold"), 1000);
  });

  it("evolves only through configured steps", async () => {
    const { wallets, characters, roster } = setup();
    wallets.set(USER, "gold", 1000);
    characters.add(USER, { uid: "T", characterId: "c1", level: 15 });
    characters.add(USER, { uid: "F1", characterId: "c1" });
    characters.add(USER, { uid: "F2", characterId: "c1" });
    characters.add(USER, { uid: "S6", characterId: "c1", stars: 6 });

    const result = await roster.evolve(USER, "T", ["F1", "F2"]);
    assert.equal(result.newStars, 2);
    assert.equal(characters.records.get("T")!.level, 1);
    await assert.rejects(roster.evolve(USER, "S6", ["T"]), isError("ROSTER_EVOLVE_STEP_MISSING"));
  });

  it("moves characters between bag and storage within capacity", async () => {
    const { characters, roster } = setup();
    characters.add(USER, { uid: "A", characterId: "c1" });
    const moved = await roster.storageMove(USER, "STORAGE", ["A"]);
    assert.equal(moved.moved, 1);
    assert.equal(moved.storageCount, 1);
    await assert.rejects(roster.storageMove(USER, "STORAGE", ["A"]), isError("ROSTER_WRONG_LOCATION"));
  });
});
