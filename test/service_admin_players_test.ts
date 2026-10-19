import assert from "node:assert/strict";

import type { AdminAuditEntry, AdminPlayerDetail, AdminPlayerList, AdminPlayerListQuery, AdminPlayerRepository } from "../src/modules/admin/admin-players.ports";
import { AdminPlayerError, AdminPlayersService } from "../src/modules/admin/admin-players.service";
import type { AdminUserDirectory, AdminUserRef } from "../src/modules/admin/admin.ports";
import type { ChatRulesDto } from "../src/modules/chat/chat.dto";
import { ChatOccupancy } from "../src/modules/chat/chat.occupancy";
import type { ChatRepository } from "../src/modules/chat/chat.ports";
import { ChatService } from "../src/modules/chat/chat.service";
import { CachedGmMuteSource } from "../src/modules/chat/gm-mute.source";
import { EconomyService } from "../src/modules/economy/economy.service";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import type { AuditEntry, AuditLog } from "../src/shared/kernel/audit";
import { FixedClock } from "../src/shared/kernel/clock";
import type { DbSession } from "../src/shared/kernel/unit-of-work";
import {
  currencyRulesOf,
  InMemoryAuthRepository,
  InMemoryProfileRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryWalletRepository,
} from "./support/fakes";

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const USER = "user-1";
const HOUR = 3600 * 1000;
const MAX_LEVEL = 50;

const currencies = currencyRulesOf([
  { id: "gold", initialAmount: 1000 },
  { id: "crystal", initialAmount: 0, hasCap: true, baseCap: 5 },
]);

/** Story rows of one player; the rest of the detail is empty (the Drizzle read model has its own e2e coverage). */
class InMemoryAdminPlayerRepository implements AdminPlayerRepository {
  mutes = new Map<string, { until: Date; reason: string | null }>();
  listQueries: AdminPlayerListQuery[] = [];
  completed = new Set<string>();
  active: string | null = null;

  async loadDetail(userId: string): Promise<Omit<AdminPlayerDetail, "wallet"> | null> {
    return {
      account: { userId, username: "alice", email: null, isGuest: false, createdAt: new Date(T0).toISOString(), lastLoginAt: null, failedLogins: 0, lockedUntil: null, ban: null, chatMute: null, deletionScheduledAt: null },
      profile: null,
      roster: { bagCapacity: 0, storageCapacity: 0, units: [] },
      runes: { capacity: 0, total: 0, items: [] },
      stages: [],
      towers: [],
      story: {
        completed: [...this.completed].map((dialogueId) => ({ dialogueId, skipped: false, times: 1, completedAt: new Date(T0).toISOString() })),
        active: this.active ? { dialogueId: this.active, step: 1 } : null,
      },
      guild: null,
      arena: null,
      connections: [],
      online: false,
    };
  }

  async auditTrail(): Promise<AdminAuditEntry[]> { return []; }

  async listPlayers(query: AdminPlayerListQuery): Promise<AdminPlayerList> {
    this.listQueries.push(query);
    return { rows: [], total: 0, counts: { all: 0, online: 0, banned: 0, muted: 0, guests: 0, deletion: 0, reported: 0 } };
  }

  async setChatMute(userId: string, until: Date | null, reason: string | null): Promise<void> {
    if (until) this.mutes.set(userId, { until, reason });
    else this.mutes.delete(userId);
  }

  async chatMutedUntil(userId: string): Promise<Date | null> { return this.mutes.get(userId)?.until ?? null; }

  async resetStory(_userId: string, dialogueIds: string[] | null, _session: DbSession): Promise<number> {
    const doomed = [...this.completed].filter((id) => !dialogueIds || dialogueIds.includes(id));
    for (const id of doomed) this.completed.delete(id);
    if (this.active && (!dialogueIds || dialogueIds.includes(this.active))) this.active = null;
    return doomed.length;
  }
}

class InMemoryUserDirectory implements AdminUserDirectory {
  users: AdminUserRef[] = [{ userId: USER, username: "alice", email: "alice@example.com" }];
  async resolve(selector: string) { return this.users.find((u) => u.userId === selector || u.username === selector || u.email === selector) ?? null; }
  async search() { return this.users; }
}

function setup(options: { knownDialogues?: string[] } = {}) {
  const clock = new FixedClock(T0);
  const wallets = new InMemoryWalletRepository();
  const profiles = new InMemoryProfileRepository();
  const auth = new InMemoryAuthRepository(() => clock.now());
  const sessions = new InMemorySessionStore();
  const players = new InMemoryAdminPlayerRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(profiles).register(auth);
  const ledger = new WalletLedger(wallets, currencies, clock);
  const economy = new EconomyService(wallets, ledger, currencies, uow, clock);
  const audits: AuditEntry[] = [];
  const audit: AuditLog = { record: async (entry) => { audits.push(entry); } };
  const disconnects: Array<{ userId: string; reason: string }> = [];
  const pushes: Array<{ userId: string; wallet: Record<string, number>; currencyAmount: number | null | undefined }> = [];
  const muteChanges: string[] = [];
  const known = new Set(options.knownDialogues ?? ["tutorial_1", "tutorial_2", "story_1", "story_2"]);

  const service = new AdminPlayersService({
    users: new InMemoryUserDirectory(),
    players,
    accounts: auth,
    sessions,
    disconnector: { disconnectPlayer: async (userId, reason) => { disconnects.push({ userId, reason }); return 2; } },
    economy,
    ledger,
    currencies,
    profiles,
    notifier: {
      pushPlayerGrant: async (userId, payload, detail) => {
        pushes.push({ userId, wallet: payload.wallet as Record<string, number>, currencyAmount: detail?.currencyAmount });
        return { deliveryCount: 1, snapshot: null };
      },
    },
    audit,
    uow,
    clock,
    maxAccountLevel: () => MAX_LEVEL,
    knownDialogue: (id) => known.has(id),
    onMuteChanged: (userId) => muteChanges.push(userId),
  });
  return { clock, wallets, profiles, auth, sessions, players, uow, audits, disconnects, pushes, muteChanges, service };
}

async function seedAccount(env: ReturnType<typeof setup>) {
  await env.auth.insertUser(USER, "alice@example.com", "alice", "hash", false);
  await env.auth.saveRefreshToken({ userId: USER, deviceId: "dev-1", tokenHash: "t1", expiresAt: new Date(T0 + 24 * HOUR) }, "ISSUE");
  await env.sessions.setSession(USER, "dev-1", { username: "alice", level: 1, nickname: "Alice", iconId: null, accessJti: "jti" });
  env.profiles.rows.set(USER, { name: "Alice", iconId: "icon_default", level: 3, currentExp: 40 });
}

const kinds = (env: ReturnType<typeof setup>) => env.audits.map((entry) => entry.kind);

describe("Admin players: ban / unban / kick", () => {
  it("bans until a date: revokes tokens and sessions, disconnects and audits", async () => {
    const env = setup();
    await seedAccount(env);
    const until = new Date(T0 + 24 * HOUR);

    const result = await env.service.ban("alice", until, "  cheating  ");

    assert.deepEqual(result, { userId: USER, until: until.toISOString(), connections: 2 });
    const row = env.auth.users.get(USER)!;
    assert.equal(row.isBanned, true);
    assert.equal(row.banReason, "cheating");
    assert.equal(row.banExpiresAt!.getTime(), until.getTime());
    assert.equal(env.auth.tokens[0].isRevoked, true);
    assert.deepEqual(env.sessions.devices(USER), []);
    assert.equal(env.disconnects.length, 1);
    assert.match(env.disconnects[0].reason, /banned until/);
    assert.deepEqual(kinds(env), ["BAN"]);
  });

  it("a permanent ban has no end date", async () => {
    const env = setup();
    await seedAccount(env);
    const result = await env.service.ban(USER, null);
    assert.equal(result.until, null);
    assert.equal(env.auth.users.get(USER)!.banExpiresAt, null);
    assert.equal(env.auth.users.get(USER)!.isBanned, true);
  });

  it("refuses a ban that already ended and changes nothing", async () => {
    const env = setup();
    await seedAccount(env);
    await assert.rejects(env.service.ban(USER, new Date(T0 - 1)), AdminPlayerError);
    assert.equal(env.auth.users.get(USER)!.isBanned, false);
    assert.equal(env.disconnects.length, 0);
  });

  it("unban clears the flag, reason and end date", async () => {
    const env = setup();
    await seedAccount(env);
    await env.service.ban(USER, null, "spam");
    await env.service.unban(USER);
    const row = env.auth.users.get(USER)!;
    assert.equal(row.isBanned, false);
    assert.equal(row.banReason, null);
    assert.deepEqual(kinds(env), ["BAN", "UNBAN"]);
  });

  it("kick drops the sessions and closes connections but keeps the refresh tokens", async () => {
    const env = setup();
    await seedAccount(env);

    const result = await env.service.kick(USER, "AFK farming");

    assert.deepEqual(result, { userId: USER, connections: 2 });
    assert.deepEqual(env.sessions.devices(USER), []);
    assert.equal(env.auth.tokens[0].isRevoked, false);
    assert.equal(env.disconnects[0].reason, "AFK farming");
    assert.deepEqual(kinds(env), ["GM_KICK"]);
  });

  it("kick without a reason uses the default notice", async () => {
    const env = setup();
    await seedAccount(env);
    await env.service.kick(USER);
    assert.equal(env.disconnects[0].reason, "Disconnected by a GM.");
  });
});

describe("Admin players: list and session revoke", () => {
  it("defaults the query and clamps paging; online means a heartbeat in the last minute", async () => {
    const env = setup();
    const result = await env.service.list({ q: "  ali ", page: 0, pageSize: 500 });

    const query = env.players.listQueries[0];
    assert.equal(query.filter, "all");
    assert.equal(query.q, "ali");
    assert.equal(query.sort, "lastLogin");
    assert.equal(query.dir, "desc");
    assert.equal(query.page, 1);
    assert.equal(query.pageSize, 100);
    assert.equal(query.now.getTime(), T0);
    assert.equal(query.onlineSince.getTime(), T0 - 60_000);
    assert.equal(result.page, 1);
  });

  it("revokes sessions and refresh tokens of every device but does not ban", async () => {
    const env = setup();
    await seedAccount(env);

    const result = await env.service.revokeSessions("alice", "shared account");

    assert.deepEqual(result, { userId: USER, connections: 2 });
    assert.equal(env.auth.tokens[0].isRevoked, true);
    assert.deepEqual(env.sessions.devices(USER), []);
    assert.equal(env.auth.users.get(USER)!.isBanned, false);
    assert.equal(env.disconnects[0].reason, "shared account");
    assert.deepEqual(kinds(env), ["GM_REVOKE_SESSIONS"]);
  });
});

describe("Admin players: chat mute", () => {
  const RULES: ChatRulesDto = {
    dirInitialPool: 1, dirMaxPool: 5, dirRecommended: 50, msgMin: 1, msgMax: 200,
    rateTokensPer10s: 100, rateBurst: 100, userWindowSec: 10, userMaxInWindow: 100, dupMuteBaseSec: 5,
  };

  /** Chat service wired like `container.ts`: GM mutes come from the admin repository through the cache. */
  function chatOn(env: ReturnType<typeof setup>) {
    const repo: ChatRepository = { insertMessage: async () => undefined, fetchHistory: async () => [] };
    const gmMutes = new CachedGmMuteSource((userId) => env.players.chatMutedUntil(userId), env.clock);
    const chat = new ChatService(repo, new ChatOccupancy(), async () => ({ nickname: "Alice", iconId: "icon_default", level: 3 }), () => RULES, env.clock, gmMutes.untilUnix);
    return { chat, gmMutes, send: () => chat.sendMessage({ channel: 0, userId: USER, ipAddress: "127.0.0.1", message: "hello" }, RULES) };
  }

  it("stores the mute with its reason and audits it", async () => {
    const env = setup();
    await seedAccount(env);
    const until = new Date(T0 + HOUR);

    const result = await env.service.mute(USER, until, "insults");

    assert.deepEqual(result, { userId: USER, until: until.toISOString() });
    assert.deepEqual(env.players.mutes.get(USER), { until, reason: "insults" });
    assert.deepEqual(env.muteChanges, [USER]);
    assert.deepEqual(kinds(env), ["GM_MUTE"]);
  });

  it("a mute without an end date is stored as a far-future date", async () => {
    const env = setup();
    await seedAccount(env);
    const result = await env.service.mute(USER, null);
    assert.ok(new Date(result.until).getTime() - T0 > 50 * 365 * 24 * HOUR);
  });

  it("refuses a mute that already ended", async () => {
    const env = setup();
    await seedAccount(env);
    await assert.rejects(env.service.mute(USER, new Date(T0 - 1000)), AdminPlayerError);
    assert.equal(env.players.mutes.size, 0);
  });

  it("ChatService refuses a GM-muted player until the mute ends or is lifted", async () => {
    const env = setup();
    await seedAccount(env);
    const { send, gmMutes } = chatOn(env);

    assert.equal((await send()).reply.ok, true);

    const until = new Date(T0 + HOUR);
    await env.service.mute(USER, until);
    gmMutes.invalidate(USER); // the container wires this through `onMuteChanged`
    const blocked = await send();
    assert.equal(blocked.reply.ok, false);
    assert.equal(blocked.reply.error, "MUTED");
    assert.equal(blocked.reply.muteUntilUnix, Math.floor(until.getTime() / 1000));
    assert.equal(blocked.broadcast, undefined);

    await env.service.unmute(USER);
    gmMutes.invalidate(USER);
    assert.equal((await send()).reply.ok, true);
    assert.deepEqual(kinds(env), ["GM_MUTE", "GM_UNMUTE"]);
  });

  it("the mute ends by itself when its date passes", async () => {
    const env = setup();
    await seedAccount(env);
    const { send } = chatOn(env);
    await env.service.mute(USER, new Date(T0 + 60_000));

    assert.equal((await send()).reply.error, "MUTED");
    env.clock.advance(61_000);
    assert.equal((await send()).reply.ok, true);
  });
});

describe("Admin players: set currency", () => {
  it("raises a balance by crediting the difference", async () => {
    const env = setup();
    await seedAccount(env);

    const result = await env.service.setCurrency(USER, "gold", 5000, "compensation");

    assert.equal(result.balance, 5000);
    assert.equal(result.clamped, false);
    assert.equal(env.wallets.amount(USER, "gold"), 5000);
    assert.equal(result.wallet.gold, 5000);
    assert.deepEqual(env.audits[0].meta, { currencyId: "gold", from: 1000, to: 5000, requested: 5000, reason: "compensation" });
    assert.equal(env.pushes.length, 1);
    assert.equal(env.pushes[0].currencyAmount, 5000);
  });

  it("lowers a balance by debiting the difference", async () => {
    const env = setup();
    await seedAccount(env);

    const result = await env.service.setCurrency(USER, "gold", 200);

    assert.equal(result.balance, 200);
    assert.equal(env.wallets.amount(USER, "gold"), 200);
    assert.deepEqual(env.audits[0].meta, { currencyId: "gold", from: 1000, to: 200, requested: 200, reason: null });
  });

  it("setting the current balance changes nothing but still audits", async () => {
    const env = setup();
    await seedAccount(env);
    const result = await env.service.setCurrency(USER, "gold", 1000);
    assert.equal(result.balance, 1000);
    assert.equal(env.wallets.amount(USER, "gold"), 1000);
    assert.deepEqual(kinds(env), ["GM_SET_CURRENCY"]);
  });

  it("stops a raise at the cap and says so", async () => {
    const env = setup();
    await seedAccount(env);
    const result = await env.service.setCurrency(USER, "crystal", 9);
    assert.equal(result.balance, 5);
    assert.equal(result.requested, 9);
    assert.equal(result.clamped, true);
    assert.equal(env.wallets.amount(USER, "crystal"), 5);
    assert.equal(env.audits[0].meta!.to, 5);
    assert.equal(env.audits[0].meta!.requested, 9);
  });

  it("floors negative amounts at zero", async () => {
    const env = setup();
    await seedAccount(env);
    const result = await env.service.setCurrency(USER, "gold", -50);
    assert.equal(result.balance, 0);
  });

  it("rejects an unknown currency without touching the wallet", async () => {
    const env = setup();
    await seedAccount(env);
    await assert.rejects(env.service.setCurrency(USER, "mithril", 10), /Unknown currency/);
    assert.equal(env.audits.length, 0);
    assert.equal(env.pushes.length, 0);
  });
});

describe("Admin players: set level", () => {
  it("sets the level and resets the EXP", async () => {
    const env = setup();
    await seedAccount(env);

    const result = await env.service.setLevel(USER, 20, "test account");

    assert.deepEqual(result, { userId: USER, level: 20 });
    assert.deepEqual(env.profiles.rows.get(USER), { name: "Alice", iconId: "icon_default", level: 20, currentExp: 0 });
    assert.deepEqual(env.audits[0].meta, { from: 3, to: 20, reason: "test account" });
  });

  it("accepts the bounds 1 and the configured maximum", async () => {
    const env = setup();
    await seedAccount(env);
    assert.equal((await env.service.setLevel(USER, 1)).level, 1);
    assert.equal((await env.service.setLevel(USER, MAX_LEVEL)).level, MAX_LEVEL);
  });

  it("rejects levels outside 1..max and non-numbers", async () => {
    const env = setup();
    await seedAccount(env);
    for (const bad of [0, -3, MAX_LEVEL + 1, Number.NaN]) {
      await assert.rejects(env.service.setLevel(USER, bad), /Level must be between 1 and 50/, `level ${bad}`);
    }
    assert.equal(env.profiles.rows.get(USER)!.level, 3);
    assert.equal(env.audits.length, 0);
  });

  it("fails when the player has no profile", async () => {
    const env = setup();
    await seedAccount(env);
    env.profiles.rows.delete(USER);
    await assert.rejects(env.service.setLevel(USER, 5), /no profile/);
  });
});

describe("Admin players: reset story", () => {
  function seedStory(env: ReturnType<typeof setup>) {
    env.players.completed = new Set(["tutorial_1", "tutorial_2", "story_1", "story_2"]);
    env.players.active = "story_2";
  }

  it("scope all forgets every sequence and the one in progress", async () => {
    const env = setup();
    await seedAccount(env);
    seedStory(env);

    const result = await env.service.resetStory(USER, "all");

    assert.equal(result.removed, 4);
    assert.equal(env.players.completed.size, 0);
    assert.equal(env.players.active, null);
    assert.deepEqual(env.audits[0].meta, { scope: "all", removed: 4 });
  });

  it("scope tutorial only touches tutorial_* ids", async () => {
    const env = setup();
    await seedAccount(env);
    seedStory(env);

    const result = await env.service.resetStory(USER, "tutorial");

    assert.equal(result.removed, 2);
    assert.deepEqual([...env.players.completed].sort(), ["story_1", "story_2"]);
    assert.equal(env.players.active, "story_2");
  });

  it("scope story also clears the active story sequence", async () => {
    const env = setup();
    await seedAccount(env);
    seedStory(env);

    const result = await env.service.resetStory(USER, "story");

    assert.equal(result.removed, 2);
    assert.deepEqual([...env.players.completed].sort(), ["tutorial_1", "tutorial_2"]);
    assert.equal(env.players.active, null);
  });

  it("an explicit id list resets only those ids (deduplicated)", async () => {
    const env = setup();
    await seedAccount(env);
    seedStory(env);

    const result = await env.service.resetStory(USER, ["story_1", " story_1 ", "tutorial_2"]);

    assert.equal(result.removed, 2);
    assert.deepEqual([...env.players.completed].sort(), ["story_2", "tutorial_1"]);
    assert.deepEqual(env.audits[0].meta, { scope: ["story_1", "tutorial_2"], removed: 2 });
  });

  it("rejects unknown ids and empty lists without removing anything", async () => {
    const env = setup();
    await seedAccount(env);
    seedStory(env);

    await assert.rejects(env.service.resetStory(USER, ["story_1", "ghost"]), /Unknown dialogue id\(s\): ghost/);
    await assert.rejects(env.service.resetStory(USER, []), AdminPlayerError);
    assert.equal(env.players.completed.size, 4);
    assert.equal(env.audits.length, 0);
  });

  it("a scope with nothing to reset removes nothing and writes no audit", async () => {
    const env = setup();
    await seedAccount(env);
    const result = await env.service.resetStory(USER, "tutorial");
    assert.equal(result.removed, 0);
    assert.equal(env.audits.length, 0);
  });
});

describe("Admin players: unknown players and detail", () => {
  it("every action fails with 'Player not found.' for an unknown selector", async () => {
    const env = setup();
    const actions: Array<[string, () => Promise<unknown>]> = [
      ["detail", () => env.service.getDetail("ghost")],
      ["audit", () => env.service.auditTrail("ghost", 10)],
      ["kick", () => env.service.kick("ghost")],
      ["ban", () => env.service.ban("ghost", null)],
      ["unban", () => env.service.unban("ghost")],
      ["mute", () => env.service.mute("ghost", null)],
      ["unmute", () => env.service.unmute("ghost")],
      ["currency", () => env.service.setCurrency("ghost", "gold", 1)],
      ["level", () => env.service.setLevel("ghost", 2)],
      ["story", () => env.service.resetStory("ghost", "all")],
    ];
    for (const [name, run] of actions) {
      await assert.rejects(run(), (error: unknown) => error instanceof AdminPlayerError && error.message === "Player not found.", name);
    }
    assert.equal(env.audits.length, 0);
    assert.equal(env.disconnects.length, 0);
  });

  it("an empty selector is refused", async () => {
    const env = setup();
    await assert.rejects(env.service.getDetail("   "), /required/);
  });

  it("resolves by id, username or email and returns the live wallet", async () => {
    const env = setup();
    await seedAccount(env);
    for (const selector of [USER, "alice", "alice@example.com"]) {
      const detail = await env.service.getDetail(selector);
      assert.equal(detail.account.userId, USER);
      assert.deepEqual(detail.wallet, { gold: 1000, crystal: 0 });
    }
  });
});
