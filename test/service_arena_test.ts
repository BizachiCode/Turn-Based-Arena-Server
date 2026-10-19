import { parseArenaConfig } from "../src/config/ArenaCatalog";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "../src/shared/errors/app-error";
import { FixedClock } from "../src/shared/kernel/clock";
import { noAudit } from "../src/shared/kernel/audit";
import { createSeededRandom } from "../src/shared/kernel/random";
import { ArenaConfigSchema, type ArenaConfig } from "../src/config/ArenaCatalog";
import { reloadCharacterCatalog, reloadCharacterCatalogFromFile } from "../src/config/CharacterCatalog";
import { reloadLeaderSkillCatalog, reloadLeaderSkillCatalogFromFile } from "../src/config/LeaderSkillCatalog";
import { ArenaBattleService } from "../src/modules/arena/arena-battle.service";
import { eloDelta, expectedScore, resolveArenaRatings } from "../src/modules/arena/arena-rating";
import { ArenaSessionFactory } from "../src/modules/arena/arena-session.factory";
import { parseOpponentId, selectOpponents } from "../src/modules/arena/arena.domain";
import { ArenaService } from "../src/modules/arena/arena.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import type { CharacterDto } from "../src/modules/roster/roster.dto";
import { InMemoryArenaRepository } from "./support/arena-fakes";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

describe("Arena rating (Elo)", () => {
  it("is symmetric at equal ratings and rewards upsets", () => {
    assert.equal(expectedScore(1000, 1000), 0.5);
    assert.equal(eloDelta(1000, 1000, true, 32), 16);
    assert.equal(eloDelta(1000, 1000, false, 32), -16);
    assert.ok(eloDelta(800, 1200, true, 32) > 16, "a weaker winner gains more");
    assert.ok(eloDelta(1200, 800, true, 32) < 16, "a stronger winner gains less");
    assert.equal(eloDelta(2000, 0, true, 32), 0, "never -0 / negative on a win");
  });

  it("mirrors the change on a real defender, clamps at 0 and never moves NPCs", () => {
    const win = resolveArenaRatings({ attackerRating: 1000, defenderRating: 1000, attackerWon: true, kFactor: 32 });
    assert.deepEqual(win, { attackerAfter: 1016, attackerDelta: 16, defenderAfter: 984, defenderDelta: -16 });

    const loss = resolveArenaRatings({ attackerRating: 1000, defenderRating: 1000, attackerWon: false, kFactor: 32 });
    assert.deepEqual(loss, { attackerAfter: 984, attackerDelta: -16, defenderAfter: 1016, defenderDelta: 16 });

    const floor = resolveArenaRatings({ attackerRating: 5, defenderRating: 3, attackerWon: false, kFactor: 32 });
    assert.equal(floor.attackerAfter, 0);
    assert.equal(floor.attackerDelta, -5);

    const defenderFloor = resolveArenaRatings({ attackerRating: 10, defenderRating: 4, attackerWon: true, kFactor: 32 });
    assert.equal(defenderFloor.defenderAfter, 0);
    assert.equal(defenderFloor.defenderDelta, -4);

    const npc = resolveArenaRatings({ attackerRating: 1000, defenderRating: 1000, attackerWon: true, kFactor: 32, defenderIsNpc: true });
    assert.equal(npc.defenderAfter, 1000);
    assert.equal(npc.defenderDelta, 0);
  });

  it("parses opponent ids", () => {
    assert.deepEqual(parseOpponentId("u:abc123"), { kind: "player", publicId: "abc123" });
    assert.deepEqual(parseOpponentId("npc:npc_rookie"), { kind: "npc", npcId: "npc_rookie" });
    assert.equal(parseOpponentId("x:abc"), null);
    assert.equal(parseOpponentId("u:"), null);
    assert.equal(parseOpponentId("u:a b"), null);
  });
});

describe("Arena opponent selection", () => {
  const random = () => createSeededRandom(7);
  /** Default `arena.json` rules: 6 opponents, rating windows ±200 then ±400. */
  const RULES = { count: 6, windows: [200, 400] };
  const player = (userId: string, rating: number) => ({ userId, rating });
  const npcs = [800, 900, 1000, 1100, 1250, 1400].map((rating) => ({ id: `npc${rating}`, rating }));
  const ids = (picks: ReturnType<typeof selectOpponents>) => picks.map((pick) => (pick.kind === "player" ? pick.player.userId : pick.npc.id));

  it("prefers players within ±200, then ±400, then anyone, and fills the rest with the closest NPCs", () => {
    const players = [player("near1", 1050), player("near2", 900), player("mid", 1350), player("far", 2500)];
    const picks = selectOpponents({ rating: 1000, players, npcs, excludeUserIds: new Set(), random: random(), ...RULES, count: 3 });
    assert.deepEqual(ids(picks).sort(), ["mid", "near1", "near2"], "±200 first, then ±400");

    const all = selectOpponents({ rating: 1000, players, npcs, excludeUserIds: new Set(), random: random(), ...RULES, count: 4 });
    assert.ok(ids(all).includes("far"), "any rating once the windows are exhausted");

    const lonely = selectOpponents({ rating: 1000, players: [player("far", 2500)], npcs, excludeUserIds: new Set(), random: random(), ...RULES });
    assert.equal(lonely.length, 6);
    assert.deepEqual(ids(lonely), ["npc800", "npc900", "npc1000", "npc1100", "npc1250", "far"].sort((a, b) => (a === "far" ? 2500 : Number(a.slice(3))) - (b === "far" ? 2500 : Number(b.slice(3)))), "closest NPCs fill the list, sorted by rating");
  });

  it("excludes the attacker and recently attacked players and never exceeds six", () => {
    const players = Array.from({ length: 12 }, (_, index) => player(`p${index}`, 1000 + index));
    const picks = selectOpponents({ rating: 1000, players, npcs, excludeUserIds: new Set(["p0", "p1", "p2"]), random: random(), ...RULES });
    assert.equal(picks.length, 6);
    assert.ok(picks.every((pick) => pick.kind === "player" && !["p0", "p1", "p2"].includes(pick.player.userId)));
  });

  it("returns only NPCs when nobody else is around", () => {
    const picks = selectOpponents({ rating: 1000, players: [], npcs, excludeUserIds: new Set(), random: random(), ...RULES });
    assert.deepEqual(ids(picks), npcs.map((npc) => npc.id));
  });
});

// ── service level tests (in-memory persistence) ───────────────────────────────────────────────

const config: ArenaConfig = ArenaConfigSchema.parse({
  turnLimit: 40,
  npcRivals: [
    { id: "rookie", name: "Rookie", rating: 900, units: [{ characterId: "foe", star: 1, level: 1 }] },
    { id: "boss", name: "Boss", rating: 1300, leaderSlotIndex: 0, units: [{ characterId: "foe", star: 1, level: 1 }, { characterId: "foe", star: 1, level: 1 }] },
  ],
});

function owned(uid: string, characterId = "hero"): CharacterDto {
  return { uid, characterId, stars: 1, level: 1, currentExp: 0, awakened: false, awakeningIndex: 0, skillLevels: [], locked: false, createdAtIso: null };
}

const stats = { hp: 1000, atk: 100, def: 100, spd: 100, sh: 0, cr: 0.15, cd: 1.5, res: 0.15, acc: 0, eva: 0 };
const skills = [{ id: "strike", targeting: "SingleEnemy", effects: [{ type: "Damage" }] }];

describe("Arena services", () => {
  let dir = "";

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-service-"));
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const character = (id: string, extra: Record<string, unknown> = {}) => ({ id, element: "fire_element", naturalStars: 1, baseStats: stats, starOverrides: [], skillIds: ["strike"], skills, ...extra });
    await reloadCharacterCatalogFromFile(write("characters.json", {
      characters: [character("hero", { leaderSkillId: "arena_cry" }), character("foe")],
    }));
    await reloadLeaderSkillCatalogFromFile(write("leader_skills.json", {
      leaderSkills: [{ id: "arena_cry", scope: "AllAllies", modeFilter: ["arena"], percentBonuses: { atk: 0.5 } }],
    }));
  });

  after(() => {
    reloadCharacterCatalog();
    reloadLeaderSkillCatalog();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const wallets = new InMemoryWalletRepository();
    const arenaRepo = new InMemoryArenaRepository(NOW);
    const uow = new InMemoryUnitOfWork().register(wallets).register(arenaRepo);
    const clock = new FixedClock(NOW);
    const currencies = currencyRulesOf([
      { id: "AW", rechargeable: true, rechargeAmount: 1, rechargeIntervalSeconds: 1800, hasCap: true, baseCap: 10 },
      { id: "GP" }, { id: "GO" }, { id: "DM" },
    ]);
    const ledger = new WalletLedger(wallets, currencies, clock);
    const rosters = new Map<string, CharacterDto[]>();
    const loadRoster = async (userId: string, uids: string[]) => (rosters.get(userId) ?? []).filter((unit) => uids.includes(unit.uid));
    const element = (characterId: string) => (characterId === "hero" || characterId === "foe" ? "fire_element" : null);

    const arena = new ArenaService({ arena: arenaRepo, ledger, uow, clock, random: createSeededRandom(3), config: () => config, loadRoster, characterElement: element });
    const battles = new ArenaBattleService({
      arena: arenaRepo,
      sessions: new ArenaSessionFactory({ loadRoster, loadEquippedRunes: async () => [] }),
      ledger, uow, clock, audit: noAudit, config: () => config,
    });

    rosters.set("alice", [owned("a1"), owned("a2")]);
    rosters.set("bob", [owned("b1"), owned("b2")]);
    wallets.set("alice", "AW", 10);
    return { wallets, arenaRepo, arena, battles, clock, rosters };
  }

  const attack = { uidsInSlots: ["a1", "a2"], leaderSlotIndex: 0 };

  it("rejects defense units the player does not own and bad formations", async () => {
    const { arena, arenaRepo, rosters } = setup();
    rosters.set("bob", [owned("b1")]);
    await assert.rejects(arena.setDefense("alice", { uidsInSlots: ["b1"], leaderSlotIndex: 0 }), isError("UNIT_NOT_OWNED"));
    await assert.rejects(arena.setDefense("alice", { uidsInSlots: ["a1", "a2"], leaderSlotIndex: 3 }).then(() => arena.setDefense("alice", { uidsInSlots: ["a1", "a1"], leaderSlotIndex: 0 })), isError("DUPLICATE_UNITS"));
    await assert.rejects(arena.setDefense("alice", { uidsInSlots: [], leaderSlotIndex: 0 }), isError("NO_UNITS"));
    assert.equal(arenaRepo.profiles.get("alice")?.defense?.uidsInSlots.length, 2, "only the valid call stored a defense");
  });

  it("builds a cached opponent list: real players near the rating, no leaks, exclusions and NPC fill", async () => {
    const { arena, arenaRepo, battles, wallets, clock } = setup();
    arenaRepo.seed("bob", { rating: 1100, defense: { uidsInSlots: ["b1", "b2"], leaderSlotIndex: 0 } });
    arenaRepo.seed("carol", { rating: 1050, defense: { uidsInSlots: ["c1"], leaderSlotIndex: 0 } });
    arenaRepo.seed("dave", { rating: 1020, defense: null });

    const first = await arena.getOpponents("alice", false);
    const ids = first.opponents.map((opponent) => opponent.opponentId);
    assert.ok(ids.includes("u:pubbob"));
    assert.ok(!ids.includes("u:pubcarol"), "carol owns none of her defense units any more");
    assert.ok(!ids.includes("u:pubdave"), "no defense, not offered");
    assert.ok(ids.includes("npc:rookie") && ids.includes("npc:boss"), "NPCs fill the list");
    assert.ok(!JSON.stringify(first).includes('"userId"') && !JSON.stringify(first).includes("b1"), "no internal ids or uids leak");
    assert.deepEqual(first.opponents.find((o) => o.opponentId === "u:pubbob")!.units, [
      { characterId: "hero", star: 1, level: 1, element: "fire_element" },
      { characterId: "hero", star: 1, level: 1, element: "fire_element" },
    ]);

    assert.deepEqual((await arena.getOpponents("alice", false)).opponents, first.opponents, "list is cached until refreshed or attacked");

    // Attacking consumes the list and hides the defender for 10 minutes.
    const adapter = await battles.startBattle("alice", { opponentId: "u:pubbob", ...attack });
    assert.equal(adapter.mode, "arena");
    assert.equal(wallets.amount("alice", "AW"), 9, "one wing spent");
    const next = await arena.getOpponents("alice", false);
    assert.ok(!next.opponents.some((opponent) => opponent.opponentId === "u:pubbob"), "recently attacked players are excluded");
    clock.advance(11 * 60_000);
    arenaRepo.battles.forEach((battle) => { battle.createdAt = new Date(NOW); });
    const later = await arena.getOpponents("alice", true);
    assert.ok(later.opponents.some((opponent) => opponent.opponentId === "u:pubbob"), "back after 10 minutes");
  });

  it("rebuilds a cached list that shows a character the catalog no longer has, for free", async () => {
    const { arena, arenaRepo, wallets } = setup();
    wallets.set("alice", "DM", 7);
    const stale = [{ opponentId: "npc:old", name: "Old", rating: 1000, level: 1, units: [{ characterId: "ghost", star: 1, level: 1, element: "fire_element" }] }];
    arenaRepo.seed("alice", { rating: 1000, opponents: stale, opponentsRefreshedAt: new Date(NOW) });

    const list = await arena.getOpponents("alice", false);
    assert.ok(list.opponents.length > 0 && !JSON.stringify(list.opponents).includes("ghost"), "unknown characters are never offered");
    assert.equal(wallets.amount("alice", "DM"), 7, "the rebuild is not a paid refresh");
    assert.deepEqual((await arena.getOpponents("alice", false)).opponents, list.opponents, "the rebuilt list is cached");
  });

  it("refresh is free every 10 minutes, then costs DM or is rejected", async () => {
    const { arena, wallets, clock } = setup();
    wallets.set("alice", "DM", 7);

    await arena.getOpponents("alice", true); // never refreshed: free
    assert.equal(wallets.amount("alice", "DM"), 7);

    const paid = await arena.getOpponents("alice", true);
    assert.equal(wallets.amount("alice", "DM"), 2, "second refresh within 10 min costs 5 DM");
    assert.equal(paid.wallet?.DM, 2);
    await assert.rejects(arena.getOpponents("alice", true), isError("NOT_ENOUGH_CURRENCY"));
    assert.equal(wallets.amount("alice", "DM"), 2);

    clock.advance(10 * 60_000);
    await arena.getOpponents("alice", true);
    assert.equal(wallets.amount("alice", "DM"), 2, "free again after 10 minutes");
  });

  it("starts battles only for offered opponents, validates ownership and spends the wing atomically", async () => {
    const { arena, arenaRepo, battles, wallets } = setup();
    arenaRepo.seed("bob", { defense: { uidsInSlots: ["b1", "b2"], leaderSlotIndex: 0 } });

    await assert.rejects(battles.startBattle("alice", { opponentId: "npc:rookie", ...attack }), isError("OPPONENT_NOT_OFFERED"), "no list yet");
    await arena.getOpponents("alice", false);
    await assert.rejects(battles.startBattle("alice", { opponentId: "npc:ghost", ...attack }), isError("OPPONENT_NOT_OFFERED"));
    await assert.rejects(battles.startBattle("alice", { opponentId: "nonsense", ...attack }), isError("OPPONENT_NOT_OFFERED"));

    await assert.rejects(battles.startBattle("alice", { opponentId: "npc:rookie", uidsInSlots: ["b1"], leaderSlotIndex: 0 }), isError("UNIT_NOT_OWNED"));
    assert.equal(wallets.amount("alice", "AW"), 10, "a rejected start costs nothing");

    wallets.set("alice", "AW", 0, new Date(NOW));
    await assert.rejects(battles.startBattle("alice", { opponentId: "npc:rookie", ...attack }), isError("NOT_ENOUGH_CURRENCY"));
    assert.equal(arenaRepo.battles.size, 0, "no battle row without the wing");
    assert.ok(arenaRepo.profiles.get("alice")!.opponents, "the list is only consumed together with the wing");

    wallets.set("alice", "AW", 1, new Date(NOW));
    const adapter = await battles.startBattle("alice", { opponentId: "npc:boss", ...attack });
    assert.equal(wallets.amount("alice", "AW"), 0);
    assert.equal(arenaRepo.battles.get(adapter.battleId)?.npcId, "boss");
    assert.equal(arenaRepo.profiles.get("alice")!.opponents, null);
  });

  it("answers NO_DEFENSE when the offered player removed his defense", async () => {
    const { arenaRepo, battles } = setup();
    arenaRepo.seed("bob", { defense: null });
    arenaRepo.profiles.get("alice") ?? arenaRepo.seed("alice");
    arenaRepo.profiles.get("alice")!.opponents = [{ opponentId: "u:pubbob", name: "Bob", rating: 1000, level: 5, units: [] }];
    await assert.rejects(battles.startBattle("alice", { opponentId: "u:pubbob", ...attack }), isError("NO_DEFENSE"));
  });

  it("plays the defender with the AI in an arena-mode battle with the arena leader skill and no leaked uids", async () => {
    const { arena, arenaRepo, battles } = setup();
    arenaRepo.seed("bob", { defense: { uidsInSlots: ["b1", "b2"], leaderSlotIndex: 0 } });
    await arena.getOpponents("alice", false);

    const adapter = await battles.startBattle("alice", { opponentId: "u:pubbob", ...attack });
    let step = adapter.start();
    const state = step.state;
    assert.equal(state.mode, "arena");
    assert.equal(state.metadata.turnLimit, 40);
    assert.equal(state.units["player-1"].stats.atk, 150, "leader skill with modeFilter arena applies to the attacker");
    assert.equal(state.units["enemy-1"].stats.atk, 150, "...and to the defender's own leader");
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes('"b1"') && !serialized.includes('"b2"') && !serialized.includes("Name-bob"), "defender uids are not in the battle state");
    assert.equal(state.teams.find((team) => team.sideId === "enemies")?.isPlayerControlled, false);

    for (let guard = 0; guard < 200 && !step.finished; guard += 1) step = adapter.usePlayerAuto();
    assert.ok(step.finished);
    assert.ok(step.victory === true || step.victory === false);
  });

  it("settles once: rating, rewards and the defender's rating are idempotent per battle id", async () => {
    const { arena, arenaRepo, battles, wallets } = setup();
    arenaRepo.seed("bob", { rating: 1000, defense: { uidsInSlots: ["b1", "b2"], leaderSlotIndex: 0 } });
    await arena.getOpponents("alice", false);
    const { battleId } = await battles.startBattle("alice", { opponentId: "u:pubbob", ...attack });

    const won = await battles.settle("alice", battleId, true);
    assert.deepEqual(won.arena, { ratingBefore: 1000, ratingAfter: 1016, delta: 16 });
    assert.deepEqual(won.currencies, [{ currencyId: "GP", amount: 10 }, { currencyId: "GO", amount: 2000 }]);
    assert.equal(won.victory, true);
    assert.equal(wallets.amount("alice", "GP"), 10);
    assert.equal(wallets.amount("alice", "GO"), 2000);
    assert.equal(arenaRepo.profiles.get("bob")!.rating, 984);
    assert.equal(arenaRepo.profiles.get("bob")!.defenseLosses, 1);

    const again = await battles.settle("alice", battleId, false);
    assert.deepEqual(again, won, "a second call replays the stored result (even with another outcome)");
    assert.equal(wallets.amount("alice", "GP"), 10);
    assert.equal(arenaRepo.profiles.get("alice")!.rating, 1016);
    assert.equal(arenaRepo.profiles.get("bob")!.rating, 984);
    assert.equal(arenaRepo.profiles.get("alice")!.wins, 1);

    const log = await arena.getDefenseLog("bob");
    assert.deepEqual(log.entries.map((entry) => [entry.attackerName, entry.defenseWon, entry.ratingChange]), [["Name-alice", false, -16]]);

    await assert.rejects(battles.settle("bob", battleId, true), isError("BATTLE_NOT_STARTED"), "only the attacker can settle his battle");
  });

  it("grants the loss reward, raises the defender and never moves NPC ratings", async () => {
    const { arena, arenaRepo, battles, wallets } = setup();
    arenaRepo.seed("bob", { rating: 1000, defense: { uidsInSlots: ["b1", "b2"], leaderSlotIndex: 0 } });
    await arena.getOpponents("alice", false);
    const loss = await battles.settle("alice", (await battles.startBattle("alice", { opponentId: "u:pubbob", ...attack })).battleId, false);
    assert.deepEqual(loss.currencies, [{ currencyId: "GP", amount: 2 }]);
    assert.deepEqual(loss.arena, { ratingBefore: 1000, ratingAfter: 984, delta: -16 });
    assert.equal(arenaRepo.profiles.get("bob")!.rating, 1016);
    assert.equal(arenaRepo.profiles.get("bob")!.defenseWins, 1);
    assert.equal(wallets.amount("alice", "GO"), 0);

    await arena.getOpponents("alice", true);
    const vsNpc = await battles.settle("alice", (await battles.startBattle("alice", { opponentId: "npc:rookie", ...attack })).battleId, true);
    assert.equal(vsNpc.arena.ratingBefore, 984);
    assert.ok(vsNpc.arena.delta > 0 && vsNpc.arena.delta < 16, "beating an NPC rated below you gives less than an even match");
  });

  it("reports the state with rank and wings, and a ranking with ties sharing the rank", async () => {
    const { arena, arenaRepo } = setup();
    arenaRepo.seed("bob", { rating: 1200 });
    arenaRepo.seed("carol", { rating: 1200 });
    const state = await arena.getState("alice");
    assert.equal(state.rating, 1000);
    assert.equal(state.rank, 3);
    assert.equal(state.wings, 10);
    assert.equal(state.defense, null);

    const ranking = await arena.getRanking("alice");
    assert.deepEqual(ranking.top.map((row) => [row.rank, row.self]), [[1, false], [1, false], [3, true]]);
    assert.deepEqual(ranking.own, { rank: 3, rating: 1000 });
  });
});

describe("Arena config rules", () => {
  it("defaults the attack cost and opponent list rules and validates the rating windows", () => {
    const cfg = parseArenaConfig("{}");
    assert.deepEqual(
      [cfg.wingCost, cfg.opponentCount, cfg.ratingWindows, cfg.freeRefreshSeconds, cfg.recentAttackHideSeconds, cfg.defenseLogSize, cfg.rankingSize],
      [1, 6, [200, 400], 600, 600, 20, 100]);
    const custom = parseArenaConfig(JSON.stringify({ WingCost: 0, OpponentCount: 3, RatingWindows: [100, 300, 900] }));
    assert.deepEqual([custom.wingCost, custom.opponentCount, custom.ratingWindows], [0, 3, [100, 300, 900]]);
    assert.throws(() => parseArenaConfig(JSON.stringify({ ratingWindows: [400, 200] })), /strictly ascending/);
    assert.throws(() => parseArenaConfig(JSON.stringify({ opponentCount: 0 })));
  });

  it("uses the configured count and windows", () => {
    const players = [{ userId: "a", rating: 1090 }, { userId: "b", rating: 1500 }];
    const picks = selectOpponents({ rating: 1000, players, npcs: [], excludeUserIds: new Set(), random: createSeededRandom(1), count: 1, windows: [100] });
    assert.deepEqual(picks.map((pick) => (pick.kind === "player" ? pick.player.userId : "")), ["a"]);
  });
});
