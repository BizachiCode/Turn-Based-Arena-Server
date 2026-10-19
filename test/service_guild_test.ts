import assert from "node:assert/strict";

import { GuildConfigSchema, type GuildConfig } from "../src/config/GuildCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { FixedClock } from "../src/shared/kernel/clock";
import { WalletLedger } from "../src/modules/economy/wallet-ledger";
import { canKick, capitalizeWords, normalizeGuildName, pickSuccessor, sanitizeGuildText, type GuildRole } from "../src/modules/guild/guild.domain";
import { GuildService, type GuildNoticeMailer } from "../src/modules/guild/guild.service";
import { currencyRulesOf, InMemoryUnitOfWork, InMemoryWalletRepository, SESSION } from "./support/fakes";
import { InMemoryGuildRepository } from "./support/guild-fakes";

const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const HOUR = 3_600_000;

describe("Guild rules", () => {
  const cfg = GuildConfigSchema.parse({});

  it("normalizes names: trims, collapses spaces, capitalizes and builds a lowercase key", () => {
    assert.deepEqual(normalizeGuildName("  dragon   knights ", cfg), { name: "Dragon Knights", key: "dragon knights" });
    assert.deepEqual(normalizeGuildName("Ab", cfg), { error: "GUILD_NAME_INVALID" }, "too short");
    assert.deepEqual(normalizeGuildName("x".repeat(21), cfg), { error: "GUILD_NAME_INVALID" }, "too long");
    assert.deepEqual(normalizeGuildName("Bad#Name", cfg), { error: "GUILD_NAME_INVALID" }, "forbidden character");
    assert.deepEqual(normalizeGuildName("<b>Bold</b>", cfg), { error: "GUILD_NAME_INVALID" }, "markup");
    assert.deepEqual(normalizeGuildName("---", cfg), { error: "GUILD_NAME_INVALID" }, "needs a letter or digit");
    assert.deepEqual(normalizeGuildName("raw name", { ...cfg, autoCapitalizeName: false }), { name: "raw name", key: "raw name" });
    assert.equal(capitalizeWords("ice  age"), "Ice  Age");
  });

  it("sanitizes texts and rejects texts over the limit", () => {
    assert.equal(sanitizeGuildText("  hi <b>there</b>\r\n\n\n\nbye\u0007 ", 120, false), "hi bthere/b\n\nbye");
    assert.equal(sanitizeGuildText("<b>ok</b>", 120, true), "<b>ok</b>");
    assert.equal(sanitizeGuildText("x".repeat(121), 120, false), null);
  });

  it("lets leaders kick anyone but leaders, officers only members", () => {
    assert.equal(canKick("leader", "officer"), true);
    assert.equal(canKick("leader", "member"), true);
    assert.equal(canKick("officer", "member"), true);
    assert.equal(canKick("officer", "officer"), false);
    assert.equal(canKick("member", "member"), false);
    assert.equal(canKick("leader", "leader"), false);
  });

  it("picks the oldest officer, else the oldest member, as successor", () => {
    const at = (h: number) => new Date(NOW + h * HOUR);
    const members = [
      { userId: "m1", role: "member" as GuildRole, joinedAt: at(1) },
      { userId: "o2", role: "officer" as GuildRole, joinedAt: at(3) },
      { userId: "o1", role: "officer" as GuildRole, joinedAt: at(2) },
    ];
    assert.equal(pickSuccessor(members)?.userId, "o1");
    assert.equal(pickSuccessor(members.filter((member) => member.role === "member"))?.userId, "m1");
    assert.equal(pickSuccessor([]), null);
  });
});

// ── service level tests (in-memory persistence) ───────────────────────────────────────────────

function setup(overrides: Partial<GuildConfig> = {}, mail: GuildNoticeMailer | null = null) {
  const clock = new FixedClock(NOW);
  const repo = new InMemoryGuildRepository(clock);
  const wallets = new InMemoryWalletRepository();
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const ledger = new WalletLedger(wallets, currencyRulesOf([{ id: "GO" }, { id: "DM" }]), clock);
  const config = { ...GuildConfigSchema.parse({}), ...overrides };
  let ids = 0;
  const service = new GuildService({
    guilds: repo, ledger, uow, clock, config: () => config, mail,
    newGuildId: () => `g${++ids}`,
    newPublicId: () => `p${(++ids).toString().padStart(3, "0")}`,
  });
  const player = (userId: string, level = 10, gold = 100_000) => {
    repo.profiles.set(userId, { name: `Name-${userId}`, level, iconId: "icon_1" });
    wallets.set(userId, "GO", gold);
    return userId;
  };
  const create = (userId: string, name = "Dragon Knights", joinType: "open" | "approval" = "open", minLevel = 1) =>
    service.create(userId, { name, description: "Hello", iconId: "emblem_lion", tags: ["casual"], joinType, minLevel });
  return { clock, repo, wallets, uow, service, config, player, create };
}

const memberIdOf = (state: Awaited<ReturnType<GuildService["getState"]>>, name: string) =>
  state.members.find((member) => member.name === name)!.memberId;

describe("Guild service", () => {
  it("creates a guild, charges the creation cost and makes the creator leader", async () => {
    const { service, wallets, player, create } = setup();
    player("u1");

    const result = await create("u1", "  dragon knights ");
    assert.equal(result.guild?.name, "Dragon Knights");
    assert.equal(result.role, "leader");
    assert.equal(result.guild?.memberCount, 1);
    assert.equal(result.guild?.notice, "");
    assert.deepEqual(result.guild?.tags, ["casual"]);
    assert.equal(result.members.length, 1);
    assert.equal(result.members[0].self, true);
    assert.deepEqual((result as { wallet?: Record<string, number> }).wallet, { GO: 90_000 });
    assert.equal(wallets.amount("u1", "GO"), 90_000);

    const state = await service.getState("u1");
    assert.equal(state.guild?.leaderName, "Name-u1");
  });

  it("rejects taken names (case-insensitive), invalid emblems/tags, low level, members and poor players without charging", async () => {
    const { service, wallets, player, create } = setup();
    player("u1");
    player("u2");
    player("low", 1);
    player("poor", 10, 5);
    await create("u1");

    await assert.rejects(create("u2", "DRAGON KNIGHTS"), isError("GUILD_NAME_TAKEN"));
    await assert.rejects(service.create("u2", { name: "Other", description: "", iconId: "nope", tags: [], joinType: "open", minLevel: 1 }), isError("GUILD_INVALID_ICON"));
    await assert.rejects(service.create("u2", { name: "Other", description: "", iconId: "emblem_lion", tags: ["x"], joinType: "open", minLevel: 1 }), isError("GUILD_INVALID_TAG"));
    await assert.rejects(service.create("u2", { name: "Other", description: "", iconId: "emblem_lion", tags: ["casual", "casual"], joinType: "open", minLevel: 1 }), isError("GUILD_INVALID_TAG"));
    await assert.rejects(service.create("u2", { name: "Other", description: "x".repeat(121), iconId: "emblem_lion", tags: [], joinType: "open", minLevel: 1 }), isError("GUILD_TEXT_TOO_LONG"));
    await assert.rejects(create("low", "Low Guild"), isError("GUILD_LEVEL_TOO_LOW"));
    await assert.rejects(create("u1", "Second Guild"), isError("GUILD_ALREADY_MEMBER"));
    await assert.rejects(create("poor", "Poor Guild"), isError("ECON_INSUFFICIENT_FUNDS"));
    assert.equal(wallets.amount("u2", "GO"), 100_000);
    assert.equal(wallets.amount("poor", "GO"), 5);

    const check = await service.checkName("dragon KNIGHTS");
    assert.equal(check.available, false);
    assert.equal(check.reason, "GUILD_NAME_TAKEN");
    assert.deepEqual(await service.checkName("new guild"), { ok: true, name: "New Guild", available: true });
  });

  it("joins open guilds right away and enforces level and capacity", async () => {
    const { service, player, create } = setup({ maxMembers: 3 });
    ["u1", "u2", "u3", "u4"].forEach((id) => player(id));
    player("low", 2);
    const created = await create("u1", "Open Guild", "open", 5);
    const guildId = created.guild!.guildId;

    const joined = await service.join("u2", guildId);
    assert.equal(joined.joined, true);
    assert.equal(joined.role, "member");
    assert.equal(joined.guild?.memberCount, 2);

    await assert.rejects(service.join("low", guildId), isError("GUILD_LEVEL_TOO_LOW"));
    await assert.rejects(service.join("u2", guildId), isError("GUILD_ALREADY_MEMBER"));
    await service.join("u3", guildId);
    await assert.rejects(service.join("u4", guildId), isError("GUILD_FULL"));
    await assert.rejects(service.join("u4", "missing"), isError("GUILD_NOT_FOUND"));
  });

  it("handles applications: limit, duplicates, expiry, cancel, accept and reject", async () => {
    const { service, clock, player, create } = setup({ maxPendingRequestsPerUser: 2 });
    ["a", "b", "c", "x", "y"].forEach((id) => player(id));
    const ga = (await create("a", "Guild A", "approval")).guild!.guildId;
    const gb = (await create("b", "Guild B", "approval")).guild!.guildId;
    const gc = (await create("c", "Guild C", "approval")).guild!.guildId;

    const applied = await service.join("x", ga);
    assert.equal(applied.requested, true);
    assert.equal(applied.guild, null);
    assert.equal(applied.myRequests.length, 1);
    await assert.rejects(service.join("x", ga), isError("GUILD_REQUEST_EXISTS"));
    await service.join("x", gb);
    await assert.rejects(service.join("x", gc), isError("GUILD_REQUEST_LIMIT"));

    const listed = await service.list("x", "");
    assert.deepEqual(listed.guilds.filter((guild) => guild.requested).map((guild) => guild.name).sort(), ["Guild A", "Guild B"]);

    // Expired requests no longer count, are hidden and are replaced by a new application.
    clock.advance(49 * HOUR);
    assert.equal((await service.getState("x")).myRequests.length, 0);
    await service.join("x", gc);
    await service.join("x", ga);
    assert.equal((await service.getState("x")).myRequests.length, 2);

    await service.cancelRequest("x", gc);
    await assert.rejects(service.cancelRequest("x", gc), isError("GUILD_REQUEST_NOT_FOUND"));

    // Only managers see and decide requests.
    await assert.rejects(service.listRequests("x"), isError("GUILD_NOT_MEMBER"));
    const leaderState = await service.getState("a");
    assert.equal(leaderState.requestCount, 1);
    const requests = await service.listRequests("a");
    assert.equal(requests.requests.length, 1);
    assert.equal(requests.requests[0].name, "Name-x");

    await service.join("y", ga);
    const yRequest = (await service.listRequests("a")).requests.find((request) => request.name === "Name-y")!;
    await service.rejectRequest("a", yRequest.requestId);
    assert.equal((await service.getState("y")).myRequests.length, 0);

    // Another guild cannot decide this request.
    await assert.rejects(service.acceptRequest("b", requests.requests[0].requestId), isError("GUILD_REQUEST_NOT_FOUND"));

    const accepted = await service.acceptRequest("a", requests.requests[0].requestId);
    assert.equal(accepted.guild?.memberCount, 2);
    const xState = await service.getState("x");
    assert.equal(xState.guild?.guildId, ga);
    assert.equal(xState.myRequests.length, 0, "joining drops the other applications");
  });

  it("drops a request whose applicant already joined another guild", async () => {
    const { service, player, create } = setup();
    ["a", "b", "x"].forEach((id) => player(id));
    const ga = (await create("a", "Guild A", "approval")).guild!.guildId;
    const gb = (await create("b", "Guild B", "open")).guild!.guildId;
    await service.join("x", ga);
    const requestId = (await service.listRequests("a")).requests[0].requestId;

    // Simulates a concurrent path that left the request behind.
    await service.join("x", gb);
    await assert.rejects(service.acceptRequest("a", requestId), isError("GUILD_REQUEST_NOT_FOUND"));
  });

  it("applies role permissions to kick, promote, demote and transfer", async () => {
    const { service, player, create } = setup({ maxOfficers: 1 });
    ["lead", "off", "m1", "m2"].forEach((id) => player(id));
    const guildId = (await create("lead", "Role Guild")).guild!.guildId;
    for (const id of ["off", "m1", "m2"]) await service.join(id, guildId);

    let state = await service.getState("lead");
    await service.setRole("lead", memberIdOf(state, "Name-off"), "officer");
    await assert.rejects(service.setRole("lead", memberIdOf(state, "Name-m1"), "officer"), isError("GUILD_OFFICER_LIMIT"));
    await assert.rejects(service.setRole("off", memberIdOf(state, "Name-m1"), "officer"), isError("GUILD_NO_PERMISSION"));
    await assert.rejects(service.setRole("lead", memberIdOf(state, "Name-lead"), "member"), isError("GUILD_INVALID_TARGET"));

    // Officers kick members only; members kick nobody.
    await assert.rejects(service.kick("m1", memberIdOf(state, "Name-m2")), isError("GUILD_NO_PERMISSION"));
    await assert.rejects(service.kick("off", memberIdOf(state, "Name-lead")), isError("GUILD_NO_PERMISSION"));
    state = await service.kick("off", memberIdOf(state, "Name-m2"));
    assert.equal(state.guild?.memberCount, 3);
    assert.equal((await service.getState("m2")).guild, null);
    await assert.rejects(service.kick("off", "unknown"), isError("GUILD_INVALID_TARGET"));

    // Members can't edit the settings; officers can.
    await assert.rejects(service.updateSettings("m1", { notice: "hi" }), isError("GUILD_NO_PERMISSION"));
    const updated = await service.updateSettings("off", { notice: "War tonight!", joinType: "approval", minLevel: 7, tags: ["arena"] });
    assert.equal(updated.guild?.notice, "War tonight!");
    assert.equal(updated.guild?.joinType, "approval");
    assert.equal(updated.guild?.minLevel, 7);
    assert.deepEqual(updated.guild?.tags, ["arena"]);

    // Transfer: target becomes leader, the old leader takes the free officer slot (or member when full).
    state = await service.getState("lead");
    const transferred = await service.transfer("lead", memberIdOf(state, "Name-off"));
    assert.equal(transferred.role, "officer");
    assert.equal(transferred.guild?.leaderName, "Name-off");

    state = await service.getState("off");
    await service.setRole("off", memberIdOf(state, "Name-lead"), "member");
    await service.setRole("off", memberIdOf(state, "Name-m1"), "officer");
    const second = await service.transfer("off", memberIdOf(state, "Name-lead"));
    assert.equal(second.role, "member", "officer slots full → member");
  });

  it("leaves: members leave, the leader must transfer first and disbands when alone", async () => {
    const { service, repo, player, create } = setup();
    ["lead", "m1"].forEach((id) => player(id));
    const guildId = (await create("lead", "Leave Guild")).guild!.guildId;
    await service.join("m1", guildId);

    await assert.rejects(service.leave("lead"), isError("GUILD_LEADER_MUST_TRANSFER"));
    const left = await service.leave("m1");
    assert.equal(left.guild, null);
    assert.equal(left.disbanded, false);
    assert.equal((await service.getState("lead")).guild?.memberCount, 1);

    const disbanded = await service.leave("lead");
    assert.equal(disbanded.disbanded, true);
    assert.equal(repo.state.guilds.size, 0);
    await assert.rejects(service.leave("lead"), isError("GUILD_NOT_MEMBER"));
  });

  it("removes deleted accounts, promoting a successor or deleting empty guilds", async () => {
    const { service, repo, player, create } = setup();
    ["lead", "off", "m1", "solo"].forEach((id) => player(id));
    const guildId = (await create("lead", "Purge Guild")).guild!.guildId;
    await service.join("m1", guildId);
    await service.join("off", guildId);
    const state = await service.getState("lead");
    await service.setRole("lead", memberIdOf(state, "Name-off"), "officer");
    await create("solo", "Solo Guild");

    await service.removeAccounts(["lead", "solo"], SESSION);
    const after = await service.getState("off");
    assert.equal(after.role, "leader", "the officer outranks the older member");
    assert.equal(after.guild?.memberCount, 2);
    assert.equal([...repo.state.guilds.values()].some((guild) => guild.name === "Solo Guild"), false);
  });

  it("mails guild notices to the players affected by someone else's decision", async () => {
    const sent: Array<{ userId: string; titleKey: string | null | undefined; params: unknown }> = [];
    const pushed: string[] = [];
    const mailer: GuildNoticeMailer = {
      sendInSession: async (_session, userId, draft) => { sent.push({ userId, titleKey: draft.titleKey, params: draft.params }); return true; },
      notify: async (userIds) => { pushed.push(...userIds); },
    };
    const { service, player, create } = setup({}, mailer);
    ["u1", "u2", "u3"].forEach((id) => player(id));
    const guildId = (await create("u1", "Notice Guild", "approval")).guild!.guildId;
    await service.join("u2", guildId);
    await service.join("u3", guildId);
    const requests = (await service.listRequests("u1")).requests;
    await service.acceptRequest("u1", requests.find((request) => request.name === "Name-u2")!.requestId);
    await service.rejectRequest("u1", requests.find((request) => request.name === "Name-u3")!.requestId);

    const state = await service.getState("u1");
    await service.setRole("u1", memberIdOf(state, "Name-u2"), "officer");
    await service.transfer("u1", memberIdOf(state, "Name-u2"));
    await service.kick("u2", memberIdOf(await service.getState("u2"), "Name-u1"));

    assert.deepEqual(sent.map((mail) => `${mail.userId}:${mail.titleKey}`), [
      "u2:text_mail_guild_accepted_title",
      "u3:text_mail_guild_rejected_title",
      "u2:text_mail_guild_promoted_title",
      "u2:text_mail_guild_leader_title",
      "u1:text_mail_guild_kicked_title",
    ]);
    assert.deepEqual(sent[0].params, ["Notice Guild"]);
    assert.deepEqual(pushed, ["u2", "u3", "u2", "u2", "u1"]);
  });

  it("serves public details and search without member handles", async () => {
    const { service, player, create } = setup();
    ["a", "x"].forEach((id) => player(id));
    const guildId = (await create("a", "Silver Lions")).guild!.guildId;
    await service.updateSettings("a", { notice: "secret" });

    const details = await service.details("x", guildId);
    assert.equal(details.guild.name, "Silver Lions");
    assert.equal("notice" in details.guild, false);
    assert.equal(details.members.length, 1);
    assert.equal("memberId" in details.members[0], false);
    await assert.rejects(service.details("x", "missing"), isError("GUILD_NOT_FOUND"));

    assert.equal((await service.list("x", "LION")).guilds.length, 1);
    assert.equal((await service.list("x", "tiger")).guilds.length, 0);
  });
});
