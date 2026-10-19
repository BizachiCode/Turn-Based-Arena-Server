import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ArenaConfigSchema, DEFAULT_SEASON_TIERS, parseArenaConfig, validateSeasonTiers, type ArenaConfig } from "../src/config/ArenaCatalog";
import { emptyPayload } from "../src/config/ShopCatalog";
import type { AuditEntry, AuditLog } from "../src/shared/kernel/audit";
import { FixedClock } from "../src/shared/kernel/clock";
import { createSeededRandom } from "../src/shared/kernel/random";
import { ArenaBattleService } from "../src/modules/arena/arena-battle.service";
import { eloDelta } from "../src/modules/arena/arena-rating";
import { planSeasonRollover, seasonAnchorMs, seasonAt, softResetRating, tierIndexFor } from "../src/modules/arena/arena-season";
import { ArenaSeasonService, type ArenaSeasonMailer } from "../src/modules/arena/arena-season.service";
import type { ArenaSessionFactory } from "../src/modules/arena/arena-session.factory";
import { ArenaService } from "../src/modules/arena/arena.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import type { MailDraft } from "../src/modules/mail/mail.service";
import { InMemoryArenaRepository } from "./support/arena-fakes";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Default anchor (Monday 2026-01-05 00:00 UTC) = start of season 1. */
const ANCHOR = Date.UTC(2026, 0, 5);
/** Season 40 runs 2026-10-05 .. 2026-10-12 (UTC). */
const S40_START = ANCHOR + 39 * WEEK;
const S40_END = S40_START + WEEK;
const NOW = S40_START + 12 * 3_600_000;

const seasonsOf = (overrides: Record<string, unknown> = {}) => ArenaConfigSchema.parse({ seasons: overrides }).seasons;
const amounts = (...entries: Array<[string, number]>) => entries.map(([currencyId, amount]) => ({ currencyId, amount }));

describe("Arena season rules", () => {
  it("derives the season window from the anchor (boundaries and before the anchor)", () => {
    assert.equal(seasonAnchorMs(seasonsOf()), ANCHOR);
    assert.deepEqual(seasonAt(ANCHOR, ANCHOR, 7), { number: 1, startsAt: ANCHOR, endsAt: ANCHOR + WEEK });
    assert.equal(seasonAt(ANCHOR + WEEK - 1, ANCHOR, 7).number, 1, "endsAt is exclusive");
    assert.deepEqual(seasonAt(ANCHOR + WEEK, ANCHOR, 7), { number: 2, startsAt: ANCHOR + WEEK, endsAt: ANCHOR + 2 * WEEK });
    assert.deepEqual(seasonAt(NOW, ANCHOR, 7), { number: 40, startsAt: S40_START, endsAt: S40_END });
    assert.deepEqual(seasonAt(ANCHOR - 5 * DAY, ANCHOR, 7), { number: 1, startsAt: ANCHOR, endsAt: ANCHOR + WEEK }, "before the anchor season 1 runs");
    assert.deepEqual(seasonAt(ANCHOR + 3 * DAY + 1, ANCHOR, 1), { number: 4, startsAt: ANCHOR + 3 * DAY, endsAt: ANCHOR + 4 * DAY });
    assert.equal(seasonAt(ANCHOR + 29 * DAY, ANCHOR, 14).number, 3);
  });

  it("resolves the tier of a rating (inclusive minRating)", () => {
    const ids = (rating: number) => DEFAULT_SEASON_TIERS[tierIndexFor(rating, DEFAULT_SEASON_TIERS)].id;
    assert.equal(ids(0), "beginner");
    assert.equal(ids(1099), "beginner");
    assert.equal(ids(1100), "challenger");
    assert.equal(ids(1249), "challenger");
    assert.equal(ids(1250), "fighter");
    assert.equal(ids(1400), "conqueror");
    assert.equal(ids(1799), "guardian");
    assert.equal(ids(1800), "legend");
    assert.equal(ids(9000), "legend");
    assert.equal(tierIndexFor(50, [{ minRating: 0 }, { minRating: 50 }, { minRating: 51 }]), 1);
  });

  it("applies the soft reset with JS rounding, keepPercent and the floor", () => {
    const reset = { base: 1000, keepPercent: 50, floor: 0 };
    assert.equal(softResetRating(1600, reset), 1300);
    assert.equal(softResetRating(1235, reset), 1118, "117.5 rounds up");
    assert.equal(softResetRating(765, reset), 883, "-117.5 rounds toward +infinity (like Math.round)");
    assert.equal(softResetRating(1000, reset), 1000);
    assert.equal(softResetRating(1999, { ...reset, keepPercent: 0 }), 1000, "keepPercent 0 = hard reset to base");
    assert.equal(softResetRating(1999, { ...reset, keepPercent: 100 }), 1999, "keepPercent 100 = no reset");
    assert.equal(softResetRating(1500, { ...reset, keepPercent: 75 }), 1375);
    assert.equal(softResetRating(50, { base: 0, keepPercent: 50, floor: 100 }), 100, "never below the floor");
    assert.ok(!Object.is(softResetRating(0, { base: 0, keepPercent: 50, floor: 0 }), -0));
  });

  it("plans rollovers: adopt, settle with or without battles, one reset per boundary", () => {
    const seasons = seasonsOf();
    assert.equal(planSeasonRollover({ season: 40, rating: 1500, seasonBattles: 3 }, 40, seasons), null, "already current");
    assert.deepEqual(planSeasonRollover({ season: 0, rating: 1500, seasonBattles: 0 }, 40, seasons), { season: 40, ratingAfter: 1500, settled: null }, "untracked: adopted");
    assert.deepEqual(planSeasonRollover({ season: 45, rating: 1500, seasonBattles: 2 }, 40, seasons), { season: 40, ratingAfter: 1500, settled: null }, "re-numbered: adopted");

    const played = planSeasonRollover({ season: 39, rating: 1310, seasonBattles: 4 }, 40, seasons)!;
    assert.equal(played.ratingAfter, 1155);
    assert.equal(played.settled?.tier.id, "fighter");
    assert.equal(played.settled?.rewarded, true);

    const idle = planSeasonRollover({ season: 39, rating: 1310, seasonBattles: 0 }, 40, seasons)!;
    assert.equal(idle.settled?.rewarded, false, "no battle, no reward");
    assert.equal(idle.ratingAfter, 1155, "the reset still applies");
    assert.equal(planSeasonRollover({ season: 39, rating: 1310, seasonBattles: 2 }, 40, seasonsOf({ minBattles: 3 }))!.settled?.rewarded, false);
    assert.equal(planSeasonRollover({ season: 39, rating: 1310, seasonBattles: 0 }, 40, seasonsOf({ minBattles: 0 }))!.settled?.rewarded, true);

    const away = planSeasonRollover({ season: 37, rating: 1600, seasonBattles: 5 }, 40, seasons)!;
    assert.equal(away.settled?.season, 37, "the season played is settled with its final rating");
    assert.equal(away.settled?.tier.id, "guardian");
    assert.equal(away.ratingAfter, 1075, "1600 -> 1300 -> 1150 -> 1075");
    assert.equal(planSeasonRollover({ season: 1, rating: 1001, seasonBattles: 1 }, 1000, seasons)!.ratingAfter, 1001, "stops at the fixed point");
  });

  it("validates the seasons config and ships valid defaults", () => {
    validateSeasonTiers(DEFAULT_SEASON_TIERS);
    const base = (seasons: Record<string, unknown>) => JSON.stringify({ seasons });
    const tiers = (...list: Array<[string, number]>) => list.map(([id, minRating]) => ({ id, minRating }));

    assert.throws(() => parseArenaConfig(base({ tiers: tiers(["a", 0], ["b", 200], ["c", 100]) })), /sorted/);
    assert.throws(() => parseArenaConfig(base({ tiers: tiers(["a", 0], ["b", 100], ["c", 100]) })), /sorted/);
    assert.throws(() => parseArenaConfig(base({ tiers: tiers(["a", 10], ["b", 100]) })), /minRating 0/);
    assert.throws(() => parseArenaConfig(base({ tiers: tiers(["a", 0], ["a", 100]) })), /Duplicate/);
    assert.throws(() => parseArenaConfig(base({ tiers: [] })));
    assert.throws(() => parseArenaConfig(base({ tiers: tiers(["bad id", 0]) })));
    assert.throws(() => parseArenaConfig(base({ anchor: "2026-01-05" })));
    assert.throws(() => parseArenaConfig(base({ anchor: "2026-02-30T00:00:00Z" })), "not a real date");
    assert.throws(() => parseArenaConfig(base({ lengthDays: 0 })));
    assert.throws(() => parseArenaConfig(base({ reset: { keepPercent: 101 } })));

    const parsed = parseArenaConfig(base({ Enabled: false, LengthDays: 14, Tiers: [{ Id: "solo", MinRating: 0, Rewards: [{ CurrencyId: "GP", Amount: 5 }] }] }));
    assert.equal(parsed.seasons.enabled, false, "PascalCase keys accepted");
    assert.equal(parsed.seasons.lengthDays, 14);
    assert.deepEqual(parsed.seasons.tiers, [{ id: "solo", name: "", minRating: 0, rewards: amounts(["GP", 5]) }]);

    const shipped = parseArenaConfig(fs.readFileSync(path.join(__dirname, "..", "game_config", "arena.json"), "utf8"));
    assert.deepEqual(shipped.seasons, seasonsOf(), "arena.json ships the default seasons");
  });
});

// ── service level ───────────────────────────────────────────────────────

function recordingMailer() {
  const sent: Array<{ userId: string; draft: MailDraft; receiptKey?: string }> = [];
  const receipts = new Set<string>();
  const pushed: string[][] = [];
  const mailer: ArenaSeasonMailer = {
    sendInSession: async (_session, userId, draft, options) => {
      const key = `${userId}|${options?.receiptKey}`;
      if (options?.receiptKey && receipts.has(key)) return false;
      if (options?.receiptKey) receipts.add(key);
      sent.push({ userId, draft, receiptKey: options?.receiptKey });
      return true;
    },
    notify: async (userIds) => { pushed.push(userIds); },
  };
  return { mailer, sent, pushed };
}

function setup(seasonOverrides: Record<string, unknown> = {}) {
  const clock = new FixedClock(NOW);
  const wallets = new InMemoryWalletRepository();
  const arenaRepo = new InMemoryArenaRepository(NOW);
  const uow = new InMemoryUnitOfWork().register(wallets).register(arenaRepo);
  const currencies = currencyRulesOf([{ id: "AW", rechargeable: true, rechargeAmount: 1, rechargeIntervalSeconds: 1800, hasCap: true, baseCap: 10 }, { id: "GP" }, { id: "GO" }, { id: "DM" }]);
  const ledger = new WalletLedger(wallets, currencies, clock);
  const audits: AuditEntry[] = [];
  const audit: AuditLog = { record: async (entry) => { audits.push(entry); } };
  const { mailer, sent, pushed } = recordingMailer();
  const holder: { config: ArenaConfig } = { config: ArenaConfigSchema.parse({ seasons: seasonOverrides }) };
  const config = () => holder.config;

  const seasons = new ArenaSeasonService({ arena: arenaRepo, uow, clock, audit, config, mail: mailer });
  const arena = new ArenaService({
    arena: arenaRepo, ledger, uow, clock, random: createSeededRandom(1), config,
    loadRoster: async () => [], characterElement: () => "fire_element", seasons,
  });
  const battles = new ArenaBattleService({
    arena: arenaRepo, sessions: {} as ArenaSessionFactory, ledger, uow, clock, audit, config, seasons,
  });
  const seasonAudits = () => audits.filter((entry) => entry.kind === "ARENA_SEASON");
  return { clock, wallets, arenaRepo, seasons, arena, battles, sent, pushed, seasonAudits, holder };
}

describe("Arena seasons (service)", () => {
  it("settles an ended season once: tier rewards by mail, soft reset and the result shown once", async () => {
    const { arena, arenaRepo, sent, pushed, seasonAudits } = setup();
    arenaRepo.seed("alice", { season: 39, rating: 1310, seasonBattles: 4 });

    const state = await arena.getState("alice");
    assert.equal(state.rating, 1155, "1000 + round(310 * 50%)");
    assert.deepEqual(state.seasonResult, {
      season: 39, tierId: "fighter", rating: 1310, battles: 4,
      rewards: amounts(["GP", 200], ["GO", 20000], ["DM", 10]), ratingAfter: 1155, mailed: true, settledAt: NOW,
    });

    assert.equal(sent.length, 1);
    const [mail] = sent;
    assert.equal(mail.userId, "alice");
    assert.equal(mail.receiptKey, "arena_season:39");
    assert.equal(mail.draft.category, "reward");
    assert.equal(mail.draft.titleKey, "text_mail_arena_season_title");
    assert.equal(mail.draft.bodyKey, "text_mail_arena_season_body");
    assert.equal(mail.draft.title, "Arena season 39 rewards");
    assert.equal(mail.draft.body, "Arena season 39 has ended. You finished in the Fighter tier with a rating of 1310. Here are your rewards!");
    assert.deepEqual(mail.draft.params, [39, "Fighter", 1310]);
    assert.deepEqual(mail.draft.attachments, { ...emptyPayload(), currencies: amounts(["GP", 200], ["GO", 20000], ["DM", 10]) });
    assert.deepEqual(pushed, [["alice"]], "the mail notice is pushed after the commit");

    assert.deepEqual({ ...state.season, tiers: state.season!.tiers.length }, {
      number: 40, startsAt: S40_START, endsAt: S40_END, serverTime: NOW, battles: 0, minBattles: 1,
      tierId: "challenger", nextTierId: "fighter", nextTierMinRating: 1250, resetRating: 1078, tiers: 6,
    });
    assert.deepEqual(state.season!.tiers[5], { id: "legend", name: "Legend", minRating: 1800, rewards: amounts(["GP", 800], ["GO", 80000], ["DM", 100]) });

    const again = await arena.getState("alice");
    assert.equal(again.seasonResult, null, "the result is announced once");
    assert.equal(again.rating, 1155, "no second reset");
    assert.equal(sent.length, 1);
    assert.equal(seasonAudits().length, 1);
    assert.equal(arenaRepo.profiles.get("alice")!.lastSeason?.season, 39, "the last result stays stored");
  });

  it("settles concurrent requests exactly once", async () => {
    const { arena, arenaRepo, sent, seasonAudits } = setup();
    arenaRepo.seed("alice", { season: 39, rating: 1650, seasonBattles: 2 });

    const [first, second, ranking] = await Promise.all([arena.getState("alice"), arena.getState("alice"), arena.getRanking("alice")]);
    assert.equal(sent.length, 1, "one reward mail");
    assert.equal(sent[0].draft.params?.[1], "Guardian");
    assert.equal(seasonAudits().length, 1);
    assert.equal(arenaRepo.profiles.get("alice")!.rating, 1325, "reset applied once (1650 -> 1325, not 1163)");
    assert.equal(arenaRepo.profiles.get("alice")!.season, 40);
    assert.equal(first.rating, 1325);
    assert.equal(second.rating, 1325);
    assert.equal(ranking.own.rating, 1325);
  });

  it("skips players without a battle in the ended season and adopts untracked profiles", async () => {
    const { arena, arenaRepo, sent, seasonAudits } = setup();
    arenaRepo.seed("bob", { season: 39, rating: 1500, seasonBattles: 0 });
    arenaRepo.seed("carol", { season: 0, rating: 1700, seasonBattles: 0 });

    const bob = await arena.getState("bob");
    assert.equal(bob.seasonResult, null);
    assert.equal(bob.rating, 1250, "reset without reward");
    assert.deepEqual(seasonAudits().map((entry) => entry.meta?.rewarded), [false]);

    const carol = await arena.getState("carol");
    assert.equal(carol.rating, 1700, "profiles from before seasons existed keep their rating");
    assert.equal(carol.season?.number, 40);
    assert.equal(arenaRepo.profiles.get("carol")!.season, 40);

    const dave = await arena.getState("dave");
    assert.equal(dave.rating, 1000);
    assert.equal(dave.season?.tierId, "beginner");
    assert.equal(sent.length, 0, "nobody fought: no mail");
  });

  it("requires minBattles attacks and ends a season exactly at endsAt", async () => {
    const { arena, arenaRepo, clock, sent } = setup({ minBattles: 3 });
    arenaRepo.seed("alice", { season: 40, rating: 1420, seasonBattles: 3 });
    arenaRepo.seed("bob", { season: 40, rating: 1420, seasonBattles: 2 });

    clock.set(S40_END - 1);
    assert.equal((await arena.getState("alice")).seasonResult, null, "season 40 still running");
    clock.set(S40_END);
    const alice = await arena.getState("alice");
    assert.equal(alice.seasonResult?.season, 40);
    assert.equal(alice.seasonResult?.tierId, "conqueror");
    assert.equal(alice.season?.number, 41);
    assert.equal(alice.season?.startsAt, S40_END);
    assert.equal((await arena.getState("bob")).seasonResult, null, "2 of 3 attacks: no reward");
    assert.deepEqual(sent.map((mail) => mail.userId), ["alice"]);
  });

  it("settles both players before a battle moves their ratings and counts attacks per season", async () => {
    const { arenaRepo, battles, arena, sent, pushed } = setup();
    arenaRepo.seed("alice", { season: 39, rating: 1400, seasonBattles: 1 });
    arenaRepo.seed("bob", { season: 39, rating: 1200, seasonBattles: 0, defense: { uidsInSlots: ["b1"], leaderSlotIndex: 0 } });
    // Started in season 39, finished in season 40.
    await arenaRepo.insertBattle({ battleId: "battle1", attackerId: "alice", defenderId: "bob", npcId: null, attackerRatingBefore: 1400 });

    const result = await battles.settle("alice", "battle1", true);
    const delta = eloDelta(1200, 1100, true, 32);
    assert.deepEqual(result.arena, { ratingBefore: 1200, ratingAfter: 1200 + delta, delta }, "Elo runs on the reset ratings");
    assert.equal(arenaRepo.profiles.get("bob")!.rating, 1100 - delta);
    assert.equal(arenaRepo.profiles.get("alice")!.seasonBattles, 1, "the attack counts for the new season");
    assert.equal(arenaRepo.profiles.get("bob")!.seasonBattles, 0, "defenses are not attacks");
    assert.deepEqual(sent.map((mail) => [mail.userId, mail.receiptKey]), [["alice", "arena_season:39"]], "bob did not attack in season 39");
    assert.deepEqual(pushed, [["alice"]]);

    assert.deepEqual(await battles.settle("alice", "battle1", false), result, "replayed, nothing settled twice");
    const state = await arena.getState("alice");
    assert.equal(state.seasonResult?.tierId, "conqueror", "a settlement done by a battle is still announced by arena/state");
    assert.equal(state.seasonResult?.ratingAfter, 1200);
    assert.equal(state.season?.battles, 1);
    assert.equal(sent.length, 1);
  });

  it("sweeps players who never come back, in batches, and is idempotent", async () => {
    const { arenaRepo, seasons, sent } = setup();
    arenaRepo.seed("p1", { season: 38, rating: 1900, seasonBattles: 5 });
    arenaRepo.seed("p2", { season: 40, rating: 1300, seasonBattles: 2 });
    arenaRepo.seed("p3", { season: 0, rating: 1500 });
    arenaRepo.seed("p4", { season: 39, rating: 800, seasonBattles: 0 });
    arenaRepo.seed("p5", { season: 39, rating: 1120, seasonBattles: 1 });

    assert.equal(await seasons.settleOutdatedProfiles(2), 3);
    const profile = (id: string) => arenaRepo.profiles.get(id)!;
    assert.deepEqual([profile("p1").season, profile("p1").rating], [40, 1225], "two boundaries: 1900 -> 1450 -> 1225");
    assert.equal(profile("p1").lastSeason?.season, 38, "rewarded for the season played");
    assert.equal(profile("p1").lastSeason?.tierId, "legend");
    assert.deepEqual([profile("p2").season, profile("p2").rating, profile("p2").seasonBattles], [40, 1300, 2], "current season untouched");
    assert.deepEqual([profile("p3").season, profile("p3").rating], [40, 1500], "adopted");
    assert.deepEqual([profile("p4").season, profile("p4").rating], [40, 900], "pulled up toward the base, no reward");
    assert.deepEqual(sent.map((mail) => [mail.userId, mail.receiptKey]).sort(), [["p1", "arena_season:38"], ["p5", "arena_season:39"]]);
    assert.deepEqual(sent.find((mail) => mail.userId === "p5")!.draft.attachments?.currencies, amounts(["GP", 100], ["GO", 10000]));

    assert.equal(await seasons.settleOutdatedProfiles(2), 0);
    assert.equal(sent.length, 2);
  });

  it("does nothing while seasons are disabled", async () => {
    const { arena, arenaRepo, seasons, sent } = setup({ enabled: false });
    arenaRepo.seed("alice", { season: 39, rating: 1500, seasonBattles: 3 });
    const state = await arena.getState("alice");
    assert.equal(state.season, null);
    assert.equal(state.seasonResult, null);
    assert.equal(state.rating, 1500);
    assert.equal(await seasons.settleOutdatedProfiles(), 0);
    assert.equal(arenaRepo.profiles.get("alice")!.season, 39);
    assert.equal(sent.length, 0);
  });
});
