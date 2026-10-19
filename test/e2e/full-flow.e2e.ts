// End-to-end test against a real MySQL/MariaDB + Redis: boots the server in-process and plays the
// main loop through the Colyseus SDK (request/response). Skipped automatically when MySQL is down.
//
//   npm run test:e2e        (uses MYSQL_* / REDIS_* from the environment or .env)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, type Room } from "@colyseus/sdk";

const PORT = Number(process.env.E2E_PORT || 2580);
const ADMIN_KEY = "e2e-admin-key-0123456789";
const CONFIG_SOURCE = path.resolve(__dirname, "../../game_config");

/** Copies the exported config and adds stage rewards, weak enemies and a shop catalog. */
function prepareConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-e2e-"));
  for (const file of fs.readdirSync(CONFIG_SOURCE)) {
    if (file.endsWith(".json")) fs.copyFileSync(path.join(CONFIG_SOURCE, file), path.join(dir, file));
  }

  const maps = JSON.parse(fs.readFileSync(path.join(dir, "maps.json"), "utf8"));
  const stage = maps.regions[0].stages[0];
  stage.rewards = [{
    difficulty: "Easy",
    currencies: [{ currencyId: "GO", amount: 300 }],
    firstClearCurrencies: [{ currencyId: "DM", amount: 10 }],
    unitExp: 50,
    dropTableId: "e2e_drops",
  }];
  maps.dropTables = [{ id: "e2e_drops", rune: { chance: 1, stars: [{ stars: 1, weight: 1 }, { stars: 2, weight: 1 }], grades: [{ grade: 1, weight: 1 }], sets: [] }, items: [] }];
  stage.difficultyScaling = [{ difficulty: "Easy", levelBonus: 0, statMultiplier: 0.05 }];
  fs.writeFileSync(path.join(dir, "maps.json"), JSON.stringify(maps));

  fs.writeFileSync(path.join(dir, "shop.json"), JSON.stringify({
    items: [{
      itemId: "e2e_gold_pack",
      basePrices: [{ kind: "HardCurrency", currencyId: "DM", amount: 5 }],
      limit: { scope: "Daily", maxPurchases: 1, giveFirstPurchaseBonus: true },
      rewards: { currencies: [{ currencyId: "GO", amount: 100 }] },
      firstPurchaseBonus: { currencies: [{ currencyId: "GO", amount: 50 }] },
    }],
  }));
  return dir;
}

process.env.NODE_ENV = "test";
process.env.CONFIG_DIR = prepareConfigDir();
process.env.CONFIG_API_KEY = ADMIN_KEY;
process.env.MYSQL_DATABASE = process.env.E2E_MYSQL_DATABASE || "arena_e2e";
process.env.DB_AUTO_MIGRATE = "true";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "warn";

type Session = { client: Client; userId: string; accessToken: string; snapshot: any };

async function guest(client: Client, deviceId: string): Promise<Session> {
  const auth = await client.joinOrCreate("auth");
  const response: any = await auth.request("auth", { type: "guest", deviceId });
  await auth.leave();
  assert.equal(response.ok, true, JSON.stringify(response));
  return { client, userId: response.userId, accessToken: response.accessToken, snapshot: response.snapshot };
}

async function adminPost(route: string, body: unknown): Promise<any> {
  const res = await fetch(`http://localhost:${PORT}/admin/runtime${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-config-api-key": ADMIN_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe("e2e: guest → stage → battle → rewards → shop", function () {
  let available = false;
  let stopServer: (() => Promise<void>) | null = null;
  let walletBefore: Record<string, number> = {};
  let player: Session;
  let unitUids: string[] = [];

  before(async function () {
    const { env } = await import("../../src/config/env");
    const { db, pool } = await import("../../src/infrastructure/database/drizzle");
    const { prepareDatabase } = await import("../../src/infrastructure/database/migrate");
    try {
      await prepareDatabase(db, env.mysql, () => undefined);
      available = true;
    } catch (error) {
      console.warn(`[e2e] skipped: ${(error as Error).message.split("\n")[0]}`);
      await pool.end().catch((): void => undefined);
      this.skip();
    }

    const { default: server } = await import("../../src/app.config");
    const { redis } = await import("../../src/infrastructure/database/redis");
    await server.listen(PORT);
    stopServer = async () => {
      await server.gracefullyShutdown(false).catch((): void => undefined);
      await redis.quit().catch((): void => undefined);
      await pool.end().catch((): void => undefined);
    };

    player = await guest(new Client(`ws://localhost:${PORT}`), `e2e-${Date.now()}`);
    for (const item of player.snapshot.wallet) walletBefore[item.id] = item.amount;
  });

  after(async () => {
    if (stopServer) await stopServer();
  });

  it("returns the account snapshot with wallet and map progress", () => {
    assert.ok(Array.isArray(player.snapshot.wallet) && player.snapshot.wallet.length > 0);
    assert.deepEqual(player.snapshot.mapProgress, []);
  });

  it("grants starter units through the admin API (GM tools only)", async () => {
    const grant = await adminPost("/grant/character", { target: player.userId, characterId: "knight_fire", copies: 2 });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    unitUids = grant.characters.map((c: { uid: string }) => c.uid);

    const roster = await player.client.joinOrCreate("roster", { accessToken: player.accessToken });
    const list: any = await roster.request("list", {});
    assert.equal(list.ok, true);
    assert.deepEqual(list.items.map((c: { uid: string }) => c.uid).sort(), [...unitUids].sort());
    await roster.leave();
  });

  it("validates the stage, plays the battle with requests and receives the rewards", async () => {
    const map = await player.client.joinOrCreate("map", { accessToken: player.accessToken });
    const start: any = await map.request("stage/validateStart", {
      regionId: "region_1", stageId: "region_1_stage_1", difficulty: "Easy", uidsInSlots: unitUids, leaderSlotIndex: 0,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    assert.equal(start.energySpent, 1);
    assert.ok(start.ticketId);

    const battle: Room = await player.client.joinOrCreate("battle_pve", { accessToken: player.accessToken });

    let frame: any = await battle.request("battle_start", {
      regionId: "region_1", stageId: "region_1_stage_1", difficulty: "Easy", uidsInSlots: unitUids, leaderSlotIndex: 0, requestId: "s",
    });
    assert.equal(frame.ok, true, JSON.stringify({ error: frame.error, message: frame.message }));

    for (let step = 0; step < 200 && !frame.finished; step++) {
      // The server tells the client which skills are usable and on which targets.
      const options = frame.actionOptions;
      assert.ok(options, `step ${step}: the server is waiting for the player`);
      const skill = options.skills.find((s: { usable: boolean }) => s.usable);
      frame = await battle.request("battle_command", {
        requestId: `c${step}`, battleId: frame.battleId, actorId: options.actorId, skillId: skill.skillId, targetId: skill.targetIds[0],
      });
      assert.equal(frame.ok, true, `step ${step}: ${frame.error}`);
    }

    assert.equal(frame.phase, "finished");
    assert.equal(frame.finished, true);
    assert.equal(frame.victory, true);
    assert.equal(frame.actionOptions, null);
    assert.equal(frame.winnerSideId, "players");
    assert.equal(frame.result.victory, true);
    assert.equal(frame.result.firstClear, true);
    assert.deepEqual(frame.result.currencies, [{ currencyId: "GO", amount: 300 }, { currencyId: "DM", amount: 10 }]);
    assert.equal(frame.result.units.length, 2);
    assert.equal(frame.result.runes.length, 1);
    assert.equal(frame.result.wallet.GO, walletBefore.GO + 300);
    assert.equal(frame.result.wallet.DM, walletBefore.DM + 10);

    const again: any = await battle.request("battle_result", { requestId: "r", battleId: frame.battleId });
    assert.deepEqual(again.result, frame.result, "rewards are granted once per battle");

    const replay: any = await battle.request("battle_start", {
      regionId: "region_1", stageId: "region_1_stage_1", difficulty: "Easy", uidsInSlots: unitUids, leaderSlotIndex: 0, requestId: "s2",
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.error, "STAGE_NOT_VALIDATED", "a ticket is consumed by one battle only");

    const progress: any = await map.request("map/progress", {});
    assert.deepEqual(progress.stages.map((s: any) => [s.regionId, s.stageId, s.difficulty, s.clears]), [["region_1", "region_1_stage_1", "Easy", 1]]);
    await battle.leave();
    await map.leave();
  });

  it("buys a shop item once per daily window with the first purchase bonus", async () => {
    const shop = await player.client.joinOrCreate("shop", { accessToken: player.accessToken });
    const state: any = await shop.request("shop/state", {});
    assert.equal(state.ok, true);
    assert.equal(state.counters[0].count, 0);

    const purchase: any = await shop.request("shop/purchase", { itemId: "e2e_gold_pack", expectedPrice: { currencyId: "DM", amount: 5 } });
    assert.equal(purchase.ok, true, JSON.stringify(purchase));
    assert.equal(purchase.firstPurchaseBonusGranted, true);
    assert.deepEqual(purchase.grants.currencies, [{ currencyId: "GO", amount: 150 }]);

    const second: any = await shop.request("shop/purchase", { itemId: "e2e_gold_pack" });
    assert.equal(second.error, "SHOP_LIMIT_REACHED");
    await shop.leave();
  });

  it("refuses removed/forbidden actions and other players' units (authority, BOLA)", async () => {
    const economy = await player.client.joinOrCreate("economy", { accessToken: player.accessToken });
    const add: any = await economy.request("economy", { type: "add", currencyId: "GO", amount: 999999 });
    assert.equal(add.ok, false);
    await economy.leave();

    const rune = await player.client.joinOrCreate("rune", { accessToken: player.accessToken });
    const grant: any = await rune.request("runes/grant", { setId: "Fatal", slot: 1, tier: 6, variant: "Normal", quality: 5 });
    assert.equal(grant.error, "FORBIDDEN");
    await rune.leave();

    const intruder = await guest(new Client(`ws://localhost:${PORT}`), `e2e-intruder-${Date.now()}`);
    const roster = await intruder.client.joinOrCreate("roster", { accessToken: intruder.accessToken });
    const steal: any = await roster.request("storage_move", { target: "STORAGE", uids: [unitUids[0]] });
    assert.equal(steal.error, "ROSTER_WRONG_LOCATION");
    const powerUp: any = await roster.request("power_up", { targetUid: unitUids[0], fodderUids: [unitUids[1]] });
    assert.equal(powerUp.error, "ROSTER_CHARACTER_NOT_FOUND");
    await roster.leave();

    const map = await intruder.client.joinOrCreate("map", { accessToken: intruder.accessToken });
    const borrowed: any = await map.request("stage/validateStart", { regionId: "region_1", stageId: "region_1_stage_1", difficulty: "Easy", uidsInSlots: [unitUids[0]], leaderSlotIndex: 0 });
    assert.equal(borrowed.code, "UNIT_NOT_OWNED");
    await map.leave();
  });

  it("plays an arena attack against another player's defense: wing, rating, rewards, defense log, BOLA", async () => {
    const rival = await guest(new Client(`ws://localhost:${PORT}`), `e2e-rival-${Date.now()}`);
    const grant = await adminPost("/grant/character", { target: rival.userId, characterId: "knight_fire", copies: 2 });
    const rivalUids: string[] = grant.characters.map((c: { uid: string }) => c.uid);

    // The e2e database survives between runs: keep only this run's players so the opponent list is deterministic.
    const { db } = await import("../../src/infrastructure/database/drizzle");
    const { arenaProfiles } = await import("../../src/infrastructure/database/schema");
    const { notInArray } = await import("drizzle-orm");
    await db.delete(arenaProfiles).where(notInArray(arenaProfiles.userId, [player.userId, rival.userId]));

    const rivalArena = await rival.client.joinOrCreate("arena", { accessToken: rival.accessToken });
    const stolen: any = await rivalArena.request("arena/setDefense", { uidsInSlots: [unitUids[0]], leaderSlotIndex: 0 });
    assert.equal(stolen.error, "UNIT_NOT_OWNED", "a defense can only use the player's own units");
    const invalid: any = await rivalArena.request("arena/setDefense", { uidsInSlots: rivalUids, leaderSlotIndex: 0, extra: 1 });
    assert.equal(invalid.ok, false, "strict payload");
    const defense: any = await rivalArena.request("arena/setDefense", { uidsInSlots: rivalUids, leaderSlotIndex: 0 });
    assert.equal(defense.ok, true, JSON.stringify(defense));

    const arena = await player.client.joinOrCreate("arena", { accessToken: player.accessToken });
    const state: any = await arena.request("arena/state", {});
    assert.deepEqual([state.ok, state.rating, state.wings, state.defense], [true, 1000, 10, null]);

    const list: any = await arena.request("arena/opponents", {});
    assert.equal(list.ok, true, JSON.stringify(list));
    const rivalEntry = list.opponents.find((o: { opponentId: string }) => o.opponentId.startsWith("u:"));
    assert.ok(rivalEntry, "the player with a defense is offered");
    assert.ok(list.opponents.some((o: { opponentId: string }) => o.opponentId.startsWith("npc:")), "NPC rivals fill the list");
    assert.ok(!JSON.stringify(list).includes(rival.userId) && !JSON.stringify(list).includes(rivalUids[0]), "no internal ids leak");

    const battle: Room = await player.client.joinOrCreate("battle_pve", { accessToken: player.accessToken });
    const unknown: any = await battle.request("battle_start_arena", { opponentId: "u:0000000000000000", uidsInSlots: unitUids, leaderSlotIndex: 0 });
    assert.equal(unknown.error, "OPPONENT_NOT_OFFERED");
    const foreign: any = await battle.request("battle_start_arena", { opponentId: rivalEntry.opponentId, uidsInSlots: rivalUids, leaderSlotIndex: 0 });
    assert.equal(foreign.error, "UNIT_NOT_OWNED", "the attack team must be owned by the attacker");

    let frame: any = await battle.request("battle_start_arena", { opponentId: rivalEntry.opponentId, uidsInSlots: unitUids, leaderSlotIndex: 0, requestId: "arena-1" });
    assert.equal(frame.ok, true, JSON.stringify({ error: frame.error, message: frame.message }));
    assert.equal(frame.state.mode, "arena");
    assert.ok(!JSON.stringify(frame.state).includes(rivalUids[0]), "defender uids are not sent to the attacker");
    const busy: any = await battle.request("battle_start_arena", { opponentId: rivalEntry.opponentId, uidsInSlots: unitUids, leaderSlotIndex: 0 });
    assert.equal(busy.error, "BATTLE_IN_PROGRESS");

    // The battle limiter (40 steps / 10 s) may kick in on long fights: wait for the bucket to refill.
    const request = async (type: string, payload: object, room: Room = battle): Promise<any> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response: any = await room.request(type, payload);
        if (response.error !== "RATE_LIMIT") return response;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error("rate limited");
    };
    for (let step = 0; step < 300 && !frame.finished; step++) {
      frame = await request("battle_auto", { requestId: `a${step}`, battleId: frame.battleId });
      assert.equal(frame.ok, true, `step ${step}: ${frame.error}`);
    }
    assert.equal(frame.finished, true);
    const { result } = frame;
    assert.equal(result.victory, frame.victory);
    assert.equal(result.arena.ratingBefore, 1000);
    assert.equal(result.arena.ratingAfter, 1000 + result.arena.delta);
    assert.equal(result.arena.delta, frame.victory ? 16 : -16);
    assert.deepEqual(result.currencies.map((c: { currencyId: string }) => c.currencyId), frame.victory ? ["GP", "GO"] : ["GP"]);
    assert.equal(result.wallet.AW, 9, "one Arena Wing spent, not refunded");

    const again: any = await request("battle_result", { requestId: "ar", battleId: frame.battleId });
    assert.deepEqual(again.result, result, `rating and rewards are applied once per battle ${JSON.stringify(again)}`);
    await battle.leave();

    const after: any = await arena.request("arena/state", {});
    assert.deepEqual([after.rating, after.wings, frame.victory ? after.wins : after.losses], [result.arena.ratingAfter, 9, 1]);
    const consumed: any = await arena.request("arena/opponents", {});
    assert.ok(!consumed.opponents.some((o: { opponentId: string }) => o.opponentId === rivalEntry.opponentId), "attacked players are hidden for a while");
    const refresh: any = await arena.request("arena/opponents", { refresh: true });
    assert.equal(refresh.ok, true);

    const log: any = await rivalArena.request("arena/defenseLog", {});
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].defenseWon, !frame.victory);
    assert.equal(log.entries[0].ratingChange, frame.victory ? -16 : 16);
    const rivalState: any = await rivalArena.request("arena/state", {});
    assert.equal(rivalState.rating, 1000 + log.entries[0].ratingChange);

    const ranking: any = await arena.request("arena/ranking", {});
    assert.equal(ranking.ok, true);
    assert.ok(ranking.top.some((row: { self: boolean }) => row.self));
    assert.equal(ranking.own.rating, after.rating);
    // Leaving an arena fight unfinished counts as a defeat (no escaping a lost battle).
    const second: any = await arena.request("arena/opponents", { refresh: true });
    const npcEntry = second.opponents.find((o: { opponentId: string }) => o.opponentId.startsWith("npc:"));
    const quitter: Room = await player.client.joinOrCreate("battle_pve", { accessToken: player.accessToken });
    const started: any = await request("battle_start_arena", { opponentId: npcEntry.opponentId, uidsInSlots: unitUids, leaderSlotIndex: 0 }, quitter);
    assert.equal(started.ok, true, JSON.stringify({ error: started.error, message: started.message }));
    await quitter.leave();
    let abandoned: any = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      abandoned = await arena.request("arena/state", {});
      if (abandoned.wins + abandoned.losses === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(abandoned.wings, 8);
    assert.equal(abandoned.losses, frame.victory ? 1 : 2);

    await arena.leave();
    await rivalArena.leave();
  });

  it("a repeated requestId returns the stored response (real database) and the logs are readable in the GM API", async () => {
    const map = await player.client.joinOrCreate("map", { accessToken: player.accessToken });
    const payload = { regionId: "region_1", stageId: "region_1_stage_1", difficulty: "Easy", uidsInSlots: unitUids, leaderSlotIndex: 0, requestId: "e2e-start-1" };
    const first: any = await map.request("stage/validateStart", payload);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.replayed, undefined);

    const [again, concurrent]: any[] = await Promise.all([map.request("stage/validateStart", payload), map.request("stage/validateStart", payload)]);
    for (const reply of [again, concurrent]) {
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.replayed, true);
      assert.equal(reply.ticketId, first.ticketId, "the same ticket, not a second one");
      assert.deepEqual(reply.wallet, first.wallet, "energy is spent once");
    }

    const other: any = await map.request("stage/validateStart", { ...payload, requestId: "e2e-start-2" });
    assert.notEqual(other.ticketId, first.ticketId);
    assert.equal(other.wallet[other.currencyId], first.wallet[first.currencyId] - first.energySpent);
    await map.leave();

    const response = await fetch(`http://localhost:${PORT}/admin/runtime/logs?limit=5`, { headers: { "x-config-api-key": ADMIN_KEY } });
    const logs: any = await response.json();
    assert.equal(logs.ok, true, JSON.stringify(logs));
    assert.equal(logs.source, "database");
    assert.ok(logs.entries.length > 0, "boot lines were persisted in server_logs");
    const summary: any = await (await fetch(`http://localhost:${PORT}/admin/runtime/logs/summary`, { headers: { "x-config-api-key": ADMIN_KEY } })).json();
    assert.ok(summary.summary.counts.info > 0);
  });

  it("rejects joins without a valid token", async () => {
    await assert.rejects(new Client(`ws://localhost:${PORT}`).joinOrCreate("economy", { accessToken: "forged" }));
  });

  it("keeps the e2e marker", () => assert.ok(available));
});
