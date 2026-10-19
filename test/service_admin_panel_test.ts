import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GuildConfigSchema } from "../src/config/GuildCatalog";
import { AdminAnalyticsService, type AdminAnalyticsRepository, type AnalyticsDailyCounts } from "../src/modules/admin/admin-analytics.service";
import { AdminConfigService } from "../src/modules/admin/admin-config.service";
import type { AdminGuildDetail, AdminGuildRepository } from "../src/modules/admin/admin-guilds.ports";
import { AdminGuildsService } from "../src/modules/admin/admin-guilds.service";
import type { AdminModerationRepository, AdminChatMessage } from "../src/modules/admin/admin-moderation.ports";
import { AdminModerationService } from "../src/modules/admin/admin-moderation.service";
import { AdminPlayerEditsService } from "../src/modules/admin/admin-player-edits.service";
import { AdminPlayerError } from "../src/modules/admin/admin-players.service";
import type { AdminUserDirectory, AdminUserRef } from "../src/modules/admin/admin.ports";
import { GuildService } from "../src/modules/guild/guild.service";
import { MonsterProgression } from "../src/modules/progression/progression.rules";
import { ProfileService } from "../src/modules/profile/profile.service";
import type { RuneRecord, RuneRepository } from "../src/modules/rune/rune.ports";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { AppError } from "../src/shared/errors/app-error";
import type { AuditEntry, AuditLog } from "../src/shared/kernel/audit";
import { FixedClock } from "../src/shared/kernel/clock";
import { cryptoRandom } from "../src/shared/kernel/random";
import type { MailDraft } from "../src/modules/mail/mail.service";
import { currencyRulesOf, InMemoryCharacterRepository, InMemoryProfileRepository, InMemoryUnitOfWork, InMemoryWalletRepository } from "./support/fakes";
import { InMemoryGuildRepository } from "./support/guild-fakes";

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const USER = "user-1";

const recordingAudit = () => {
  const entries: AuditEntry[] = [];
  const audit: AuditLog = { record: async (entry) => { entries.push(entry); } };
  return { entries, audit, kinds: () => entries.map((entry) => entry.kind) };
};

class UserDirectory implements AdminUserDirectory {
  users: AdminUserRef[] = [
    { userId: USER, username: "alice", email: "alice@example.com" },
    { userId: "user-2", username: "bob", email: "bob@example.com" },
  ];
  async resolve(selector: string) { return this.users.find((u) => u.userId === selector || u.username === selector) ?? null; }
  async search() { return this.users; }
}

/** Minimal in-memory rune rows (only what the GM edits touch). */
class FakeRuneRepository {
  runes = new Map<string, Pick<RuneRecord, "uid" | "setId" | "slot" | "level" | "quality" | "equippedToUid"> & { userId: string }>();
  async listEquippedOn(userId: string, characterUids: string[]) {
    return [...this.runes.values()].filter((r) => r.userId === userId && r.equippedToUid && characterUids.includes(r.equippedToUid)) as unknown as RuneRecord[];
  }
  async setEquipped(userId: string, uid: string, characterUid: string | null) {
    const rune = this.runes.get(uid);
    if (!rune || rune.userId !== userId) return 0;
    rune.equippedToUid = characterUid;
    return 1;
  }
  async find(userId: string, uid: string) {
    const rune = this.runes.get(uid);
    return rune && rune.userId === userId ? ({ ...rune } as unknown as RuneRecord) : null;
  }
  async delete(userId: string, uid: string) {
    const rune = this.runes.get(uid);
    if (!rune || rune.userId !== userId) return 0;
    this.runes.delete(uid);
    return 1;
  }
}

const progression = new MonsterProgression({
  starTiers: () => [1, 2, 3, 4, 5, 6].map((stars) => ({ stars, maxLevel: 10 + stars * 5, expPerLevel: [] })),
  powerUp: () => ({ currencyId: "GO", costPerFodderStarUnit: 0, expMultiplierByStars: [], minFodderBaseLevel: 1 }),
  evolve: () => ({ currencyId: "GO", costPerStarUnit: 0, steps: [] }),
});

function editsSetup(options: { reserved?: string[] } = {}) {
  const clock = new FixedClock(T0);
  const characters = new InMemoryCharacterRepository();
  const profiles = new InMemoryProfileRepository();
  const runes = new FakeRuneRepository();
  const uow = new InMemoryUnitOfWork().register(characters).register(profiles);
  const { entries, audit, kinds } = recordingAudit();
  const sent: Array<{ userId: string; draft: MailDraft }> = [];
  const invalidated = { roster: [] as string[], runes: [] as string[] };
  const guildCalls: string[] = [];
  const nicknames = new ProfileService(
    profiles,
    { exists: () => true, defaultIconId: () => "icon_default" },
    () => ({ minLength: 3, maxLength: 12, canUseSpecialChar: false }),
    cryptoRandom,
  );
  const service = new AdminPlayerEditsService({
    users: new UserDirectory(),
    nicknames,
    mail: {
      validateAttachments: (attachments) => { if (attachments && (attachments as { bad?: boolean }).bad) throw new AppError("INVALID_PAYLOAD"); },
      send: async (userId, draft) => { sent.push({ userId, draft }); return true; },
    },
    guilds: {
      operatorRemoveMember: async (userId) => {
        guildCalls.push(userId);
        if (userId === "user-2") throw new AppError("GUILD_NOT_MEMBER");
        return { guildId: "g1", disbanded: false };
      },
    },
    characters,
    runes: runes as unknown as RuneRepository,
    progression,
    reserved: { reservedUids: async () => new Set(options.reserved ?? []) },
    invalidateRoster: async (userId) => { invalidated.roster.push(userId); },
    invalidateRunes: async (userId) => { invalidated.runes.push(userId); },
    audit,
    uow,
  });
  profiles.rows.set(USER, { name: "Alice", iconId: "icon_default", level: 5, currentExp: 0 });
  profiles.rows.set("user-2", { name: "Bobby", iconId: "icon_default", level: 5, currentExp: 0 });
  return { service, characters, profiles, runes, entries, kinds, sent, invalidated, guildCalls, clock };
}

describe("Admin player edits", () => {
  it("renames with the client validation and audits the change", async () => {
    const env = editsSetup();
    const result = await env.service.rename("alice", "  Alicia ", "support ticket");
    assert.deepEqual(result, { userId: USER, from: "Alice", nickname: "Alicia" });
    assert.equal(env.profiles.rows.get(USER)!.name, "Alicia");
    assert.deepEqual(env.entries[0], { userId: USER, kind: "GM_RENAME", meta: { from: "Alice", to: "Alicia", reason: "support ticket" } });
  });

  it("refuses invalid and taken nicknames without changing anything", async () => {
    const env = editsSetup();
    await assert.rejects(env.service.rename(USER, "x"), (error: unknown) => error instanceof AppError && error.errorCode === "TOO_SHORT");
    await assert.rejects(env.service.rename(USER, "Bad#Name"), (error: unknown) => error instanceof AppError && error.errorCode === "INVALID_CHARS");
    await assert.rejects(env.service.rename(USER, "Bobby"), (error: unknown) => error instanceof AppError && error.errorCode === "PROFILE_NAME_TAKEN");
    assert.equal(env.profiles.rows.get(USER)!.name, "Alice");
    assert.deepEqual(env.entries, []);
  });

  it("sends a GM mail to one player and audits it", async () => {
    const env = editsSetup();
    await env.service.sendMail("bob", { title: "Sorry", body: "Compensation", attachments: null }, "bug 12");
    assert.equal(env.sent[0].userId, "user-2");
    assert.equal(env.sent[0].draft.category, "gm");
    assert.deepEqual(env.entries[0], { userId: "user-2", kind: "GM_MAIL", meta: { title: "Sorry", reason: "bug 12" } });
  });

  it("does not send a mail whose rewards the catalogs refuse", async () => {
    const env = editsSetup();
    await assert.rejects(env.service.sendMail(USER, { title: "x", attachments: { bad: true } as never }));
    assert.deepEqual(env.sent, []);
  });

  it("deletes a unit after unequipping its runes", async () => {
    const env = editsSetup();
    env.characters.add(USER, { uid: "c1", characterId: "hero", stars: 3, level: 7 });
    env.runes.runes.set("r1", { userId: USER, uid: "r1", setId: "Fatal", slot: 1, level: 3, quality: 2, equippedToUid: "c1" });

    const result = await env.service.deleteUnit(USER, "c1", "duplicate");

    assert.deepEqual(result, { userId: USER, uid: "c1", unequipped: 1 });
    assert.equal(env.characters.records.has("c1"), false);
    assert.equal(env.runes.runes.get("r1")!.equippedToUid, null);
    assert.deepEqual(env.invalidated, { roster: [USER], runes: [USER] });
    assert.deepEqual(env.kinds(), ["GM_DELETE_UNIT"]);
  });

  it("refuses to delete a unit of the arena defense, a foreign unit or an unknown one", async () => {
    const env = editsSetup({ reserved: ["c1"] });
    env.characters.add(USER, { uid: "c1", characterId: "hero" });
    env.characters.add("user-2", { uid: "c2", characterId: "hero" });
    await assert.rejects(env.service.deleteUnit(USER, "c1"), AdminPlayerError);
    await assert.rejects(env.service.deleteUnit(USER, "c2"), AdminPlayerError);
    await assert.rejects(env.service.deleteUnit(USER, "nope"), AdminPlayerError);
    assert.equal(env.characters.records.size, 2);
    assert.deepEqual(env.entries, []);
  });

  it("sets level within the star tier and resets the level when the stars change", async () => {
    const env = editsSetup();
    env.characters.add(USER, { uid: "c1", characterId: "hero", stars: 2, level: 4 });

    assert.deepEqual(await env.service.setUnit(USER, "c1", { level: 20 }), { userId: USER, uid: "c1", stars: 2, level: 20 });
    assert.equal(env.characters.records.get("c1")!.level, 20);

    assert.deepEqual(await env.service.setUnit(USER, "c1", { stars: 4 }), { userId: USER, uid: "c1", stars: 4, level: 1 });
    assert.deepEqual(await env.service.setUnit(USER, "c1", { stars: 5, level: 35 }), { userId: USER, uid: "c1", stars: 5, level: 35 });
    assert.deepEqual(env.kinds(), ["GM_SET_UNIT", "GM_SET_UNIT", "GM_SET_UNIT"]);
  });

  it("rejects levels above the tier, invalid stars and empty edits", async () => {
    const env = editsSetup();
    env.characters.add(USER, { uid: "c1", characterId: "hero", stars: 2, level: 4 });
    await assert.rejects(env.service.setUnit(USER, "c1", { level: 21 }), /between 1 and 20/);
    await assert.rejects(env.service.setUnit(USER, "c1", { stars: 7 }), /Stars must be/);
    await assert.rejects(env.service.setUnit(USER, "c1", {}), /Nothing to change/);
    assert.equal(env.characters.records.get("c1")!.level, 4);
    assert.deepEqual(env.entries, []);
  });

  it("deletes a rune, taking it off its unit first", async () => {
    const env = editsSetup();
    env.runes.runes.set("r1", { userId: USER, uid: "r1", setId: "Fatal", slot: 2, level: 0, quality: 1, equippedToUid: "c1" });
    assert.deepEqual(await env.service.deleteRune(USER, "r1"), { userId: USER, uid: "r1" });
    assert.equal(env.runes.runes.size, 0);
    assert.deepEqual(env.invalidated.runes, [USER]);
    assert.equal((env.entries[0].meta as { equippedTo: string }).equippedTo, "c1");
    await assert.rejects(env.service.deleteRune(USER, "r1"), AdminPlayerError);
  });

  it("removes a player from the guild and explains when they are not in one", async () => {
    const env = editsSetup();
    assert.deepEqual(await env.service.removeFromGuild(USER, "toxic"), { userId: USER, guildId: "g1", disbanded: false });
    assert.deepEqual(env.entries[0], { userId: USER, kind: "GM_GUILD_REMOVE", meta: { guildId: "g1", disbanded: false, reason: "toxic" } });
    await assert.rejects(env.service.removeFromGuild("bob"), /not in a guild/);
  });
});

// ── Guild operator actions (GuildService + AdminGuildsService) ──────────────────────────────

function guildSetup() {
  const clock = new FixedClock(T0);
  const repo = new InMemoryGuildRepository(clock);
  const wallets = new InMemoryWalletRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "GO" }]), clock);
  const mails: Array<{ userId: string; title: string }> = [];
  const events: Array<{ kind: string; userId: string }> = [];
  let ids = 0;
  const guilds = new GuildService({
    guilds: repo, ledger, uow, clock, config: () => GuildConfigSchema.parse({}),
    mail: { sendInSession: async (_session, userId, draft) => { mails.push({ userId, title: String(draft.title) }); return true; }, notify: async () => undefined },
    events: { guildChanged: async (event) => { events.push({ kind: event.kind, userId: event.userId }); } },
    newGuildId: () => `g${++ids}`,
    newPublicId: () => `p${(++ids).toString().padStart(3, "0")}`,
  });
  const player = (userId: string, level = 10) => {
    repo.profiles.set(userId, { name: `Name-${userId}`, level, iconId: "icon_1" });
    wallets.set(userId, "GO", 100_000);
  };
  const { entries, audit, kinds } = recordingAudit();
  const view: AdminGuildRepository = {
    list: async () => ({ rows: [], total: 0, counts: { all: 0, open: 0, approval: 0 } }),
    detail: async (guildId) => {
      const guild = repo.state.guilds.get(guildId);
      if (!guild) return null;
      return { guild: { guildId, name: guild.name } } as unknown as AdminGuildDetail;
    },
  };
  const service = new AdminGuildsService({ repo: view, guilds, audit });
  const create = async () => {
    for (const id of ["leader", "m1", "m2"]) player(id);
    await guilds.create("leader", { name: "Dragon Knights", description: "", iconId: "emblem_lion", tags: [], joinType: "open", minLevel: 1 });
    const guildId = [...repo.state.guilds.keys()][0];
    await guilds.join("m1", guildId);
    await guilds.join("m2", guildId);
    const publicId = (userId: string) => repo.state.members.get(userId)!.publicId;
    return { guildId, publicId };
  };
  return { repo, guilds, service, entries, kinds, mails, events, create };
}

describe("Admin guild operator actions", () => {
  it("kicks a member without an acting leader, notifies them and audits it", async () => {
    const env = guildSetup();
    const { guildId, publicId } = await env.create();

    const result = await env.service.kick(guildId, publicId("m1"), "spam");

    assert.deepEqual(result, { userId: "m1" });
    assert.equal(env.repo.state.members.has("m1"), false);
    assert.equal(env.repo.state.guilds.get(guildId)!.memberCount, 2);
    assert.deepEqual(env.mails.map((mail) => mail.userId), ["m1"]);
    assert.ok(env.events.some((event) => event.kind === "kicked" && event.userId === "m1"));
    assert.deepEqual(env.entries[0], { userId: "m1", kind: "GM_GUILD_KICK", meta: { guildId, reason: "spam" } });
  });

  it("cannot kick the leader through the member handle", async () => {
    const env = guildSetup();
    const { guildId, publicId } = await env.create();
    await assert.rejects(env.service.kick(guildId, publicId("leader")), /GUILD_INVALID_TARGET/);
    assert.equal(env.repo.state.members.has("leader"), true);
  });

  it("transfers the lead: the old leader becomes officer", async () => {
    const env = guildSetup();
    const { guildId, publicId } = await env.create();

    await env.service.transfer(guildId, publicId("m2"));

    assert.equal(env.repo.state.members.get("m2")!.role, "leader");
    assert.equal(env.repo.state.members.get("leader")!.role, "officer");
    assert.deepEqual(env.kinds(), ["GM_GUILD_LEADER"]);
    assert.equal(env.entries[0].userId, "m2");
  });

  it("disbands: every member is told and the guild is gone", async () => {
    const env = guildSetup();
    const { guildId } = await env.create();

    assert.deepEqual(await env.service.disband(guildId, "abuse"), { members: 3 });

    assert.equal(env.repo.state.guilds.size, 0);
    assert.equal(env.repo.state.members.size, 0);
    assert.deepEqual(env.mails.map((mail) => mail.userId).sort(), ["leader", "m1", "m2"]);
    assert.equal((env.entries[0].meta as { name: string }).name, "Dragon Knights");
  });

  it("renames with the creation rules and edits notice / description", async () => {
    const env = guildSetup();
    const { guildId } = await env.create();

    await env.service.update(guildId, { name: "  night owls ", notice: "Be nice" }, "inappropriate name");

    const guild = env.repo.state.guilds.get(guildId)!;
    assert.equal(guild.name, "Night Owls");
    assert.equal(guild.notice, "Be nice");
    assert.deepEqual(env.entries[0].meta, { guildId, fields: ["name", "notice"], reason: "inappropriate name" });

    await assert.rejects(env.service.update(guildId, { name: "x" }), /GUILD_NAME_INVALID/);
    await assert.rejects(env.service.update(guildId, {}), /Nothing to change/);
  });

  it("refuses a name another guild already uses", async () => {
    const env = guildSetup();
    const { guildId } = await env.create();
    env.repo.profiles.set("other", { name: "Other", level: 10, iconId: "icon_1" });
    (env.repo as unknown as { state: { guilds: Map<string, unknown> } }).state.guilds.set("g99", {
      id: "g99", name: "Night Owls", nameKey: "night owls", description: "", notice: "", iconId: "emblem_lion", tags: [], joinType: "open", minLevel: 1, memberCount: 1, createdAt: new Date(T0),
    });
    await assert.rejects(env.service.update(guildId, { name: "night owls" }), /GUILD_NAME_TAKEN/);
    assert.equal(env.repo.state.guilds.get(guildId)!.name, "Dragon Knights");
  });

  it("removes a leader with other members: the oldest member takes over; a lone leader disbands", async () => {
    const env = guildSetup();
    const { guildId } = await env.create();

    assert.deepEqual(await env.guilds.operatorRemoveMember("leader"), { guildId, disbanded: false });
    assert.equal(env.repo.state.members.has("leader"), false);
    assert.equal(env.repo.state.members.get("m1")!.role, "leader");

    await env.guilds.operatorRemoveMember("m2");
    assert.deepEqual(await env.guilds.operatorRemoveMember("m1"), { guildId, disbanded: true });
    assert.equal(env.repo.state.guilds.size, 0);
    await assert.rejects(env.guilds.operatorRemoveMember("m1"), (error: unknown) => error instanceof AppError && error.errorCode === "GUILD_NOT_MEMBER");
  });
});

// ── Analytics ───────────────────────────────────────────────────────────────────────────────

describe("Admin analytics", () => {
  const dayKey = (offset: number) => new Date(Date.UTC(2026, 9, 15) + offset * DAY).toISOString().slice(0, 10);

  function analyticsOn(counts: AnalyticsDailyCounts, active = { now: 12, before: 8 }) {
    const calls: Array<[Date, Date]> = [];
    const repo: AdminAnalyticsRepository = {
      dailyCounts: async (from, to) => { calls.push([from, to]); return counts; },
      distinctActive: async (from) => (from.getTime() >= Date.UTC(2026, 9, 9) ? active.now : active.before),
      totalAccounts: async () => 120,
    };
    return { service: new AdminAnalyticsService({ repo, clock: new FixedClock(T0) }), calls };
  }

  it("builds one point per day, zero-filled, oldest first, over the requested period", async () => {
    const { service, calls } = analyticsOn({ newAccounts: { [dayKey(0)]: 4, [dayKey(-2)]: 1 } });
    const result = await service.overview(7);

    assert.equal(result.dates.length, 7);
    assert.equal(result.dates[0], dayKey(-6));
    assert.equal(result.dates[6], dayKey(0));
    assert.deepEqual(result.series.newAccounts, [0, 0, 0, 0, 1, 0, 4]);
    assert.equal(result.totalAccounts, 120);
    // The query covers the previous period too: 14 days ending tomorrow 00:00 (exclusive).
    assert.equal(calls[0][0].getTime(), Date.UTC(2026, 9, 2));
    assert.equal(calls[0][1].getTime(), Date.UTC(2026, 9, 16));
  });

  it("totals carry the delta against the previous period; active players use the distinct count", async () => {
    const { service } = analyticsOn({
      newAccounts: { [dayKey(0)]: 5, [dayKey(-7)]: 2 },
      activePlayers: { [dayKey(0)]: 3, [dayKey(-1)]: 4 },
    });
    const { totals } = await service.overview(7);

    assert.deepEqual(totals.newAccounts, { value: 5, previous: 2, delta: 3 });
    assert.deepEqual(totals.activePlayers, { value: 12, previous: 8, delta: 4 });
  });

  it("sums PvE and arena battles and follows the most spent shop currency", async () => {
    const { service } = analyticsOn({
      pveBattles: { [dayKey(0)]: 10 },
      arenaBattles: { [dayKey(0)]: 3, [dayKey(-1)]: 1 },
      "shopSpent:GO": { [dayKey(0)]: 500 },
      "shopSpent:DM": { [dayKey(0)]: 90, [dayKey(-1)]: 60 },
    });
    const result = await service.overview(7);

    assert.equal(result.series.battles[6], 13);
    assert.equal(result.totals.battles.value, 14);
    assert.equal(result.shopSpentCurrency, "GO");
    assert.equal(result.totals.shopSpent.value, 500);
  });

  it("clamps the period to 1..90 days", async () => {
    const { service } = analyticsOn({});
    assert.equal((await service.overview(0)).days, 7);
    assert.equal((await service.overview(500)).days, 90);
    assert.equal((await service.overview(1)).dates.length, 1);
  });
});

// ── Moderation (chat, mail history, audit) ──────────────────────────────────────────────────

describe("Admin moderation", () => {
  const line = (id: number, userId: string | null): AdminChatMessage => ({
    id, scope: "global", channel: 1, guildId: null, guildName: null, userId, nickname: "Alice", level: 5,
    message: "buy gold at example.com", original: null, system: false, createdAt: new Date(T0).toISOString(),
  });

  function moderationSetup() {
    const messages = new Map<number, AdminChatMessage>([[10, line(10, USER)]]);
    const broadcasts = new Map<string, string>([["b1", "Maintenance gift"]]);
    const queries: unknown[] = [];
    const repo: AdminModerationRepository = {
      chatMessages: async (query) => { queries.push(query); return [...messages.values()]; },
      chatChannels: async () => [],
      deleteChatMessage: async (_scope, id) => { const found = messages.get(id) ?? null; messages.delete(id); return found; },
      broadcasts: async () => [],
      directMails: async () => [],
      revokeBroadcast: async (id) => { const title = broadcasts.get(id); broadcasts.delete(id); return title ? { title } : null; },
      auditLog: async (query) => { queries.push(query); return []; },
      auditKinds: async () => ["BAN", "LOGIN"],
    };
    const { entries, audit } = recordingAudit();
    return { service: new AdminModerationService({ repo, audit, clock: new FixedClock(T0) }), messages, broadcasts, entries, queries };
  }

  it("deletes a chat line and audits it on the sender's trail", async () => {
    const env = moderationSetup();
    const { message } = await env.service.deleteChatMessage("global", 10, "spam");
    assert.equal(message.id, 10);
    assert.equal(env.messages.size, 0);
    assert.deepEqual(env.entries[0].kind, "GM_CHAT_DELETE");
    assert.equal(env.entries[0].userId, USER);
    assert.deepEqual(env.entries[0].meta, { scope: "global", id: 10, channel: 1, guildId: null, text: "buy gold at example.com", reason: "spam" });
    await assert.rejects(env.service.deleteChatMessage("global", 10), AdminPlayerError);
  });

  it("defaults the chat and audit queries (page size, no filters)", async () => {
    const env = moderationSetup();
    await env.service.chat({ scope: "guild", guildId: "g1" });
    await env.service.auditLog({ kind: "BAN" });
    assert.deepEqual(env.queries[0], { scope: "guild", channel: null, guildId: "g1", userId: null, limit: 50, before: null });
    assert.deepEqual(env.queries[1], { kind: "BAN", userId: null, from: null, to: null, before: null, limit: 50 });
  });

  it("revokes a broadcast once and audits it", async () => {
    const env = moderationSetup();
    assert.deepEqual(await env.service.revokeBroadcast("b1", "wrong reward"), { id: "b1", title: "Maintenance gift" });
    assert.deepEqual(env.entries[0], { userId: null, kind: "GM_MAIL_REVOKE", meta: { broadcastId: "b1", title: "Maintenance gift", reason: "wrong reward" } });
    await assert.rejects(env.service.revokeBroadcast("b1"), AdminPlayerError);
  });
});

// ── Config summary ──────────────────────────────────────────────────────────────────────────

describe("Admin config summary", () => {
  it("describes the catalog files: counts and version marker; skips bundles", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gm-config-"));
    try {
      await fsp.writeFile(path.join(dir, "characters.json"), JSON.stringify({ version: 3, characters: [{}, {}, {}], meta: { a: 1, b: 2 }, name: "x" }));
      await fsp.writeFile(path.join(dir, "list.json"), JSON.stringify([1, 2]));
      await fsp.writeFile(path.join(dir, "broken.json"), "{ nope");
      await fsp.mkdir(path.join(dir, "bundle_2026-10-15"));

      const files = await new AdminConfigService(dir).files();

      assert.deepEqual(files.map((file) => file.file), ["broken.json", "characters.json", "list.json"]);
      const characters = files.find((file) => file.file === "characters.json")!;
      assert.deepEqual(characters.counts, { characters: 3, meta: 2 });
      assert.equal(characters.version, "3");
      assert.deepEqual(files.find((file) => file.file === "list.json")!.counts, { items: 2 });
      assert.deepEqual(files.find((file) => file.file === "broken.json")!.counts, {});
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("answers an empty list when the directory does not exist", async () => {
    assert.deepEqual(await new AdminConfigService(path.join(os.tmpdir(), "gm-config-missing-dir")).files(), []);
  });
});
