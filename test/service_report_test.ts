import assert from "node:assert/strict";

import { ReportService } from "../src/modules/report/report.service";
import { DEFAULT_REPORT_RULES, normalizeReportRules, reportEvidenceText, type ReportRules } from "../src/modules/report/report.rules";
import { ReportPlayerSchema } from "../src/modules/report/report.validation";
import { FixedClock } from "../src/shared/kernel/clock";
import { InMemoryUnitOfWork } from "./support/fakes";
import { InMemoryReportStore } from "./support/report-fakes";

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const ALICE = "alice";
const BOB = "bob";
const CARL = "carl";

function setup(rules: Partial<ReportRules> = {}, guilds: Record<string, string> = {}) {
  const clock = new FixedClock(T0);
  const store = new InMemoryReportStore(clock).addUser(ALICE, "Alice").addUser(BOB, "Bob").addUser(CARL, "Carl");
  const service = new ReportService({
    repo: store,
    uow: new InMemoryUnitOfWork(),
    clock,
    rules: () => ({ ...DEFAULT_REPORT_RULES, categories: [...DEFAULT_REPORT_RULES.categories], cooldownSeconds: 0, ...rules }),
    guildOf: async (userId) => guilds[userId] ?? null,
  });
  return { clock, store, service };
}

async function codeOf(work: Promise<unknown>): Promise<{ error: string; fields?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const typed = error as { errorCode?: string; fields?: Record<string, unknown> };
    return { error: typed.errorCode ?? String(error), fields: typed.fields };
  }
  throw new Error("expected the report to be refused");
}

describe("Player reports", () => {
  it("stores an open report scoped to the session user", async () => {
    const { service, store } = setup();
    const result = await service.report(ALICE, { targetUserId: BOB, category: "spam", comment: "  keeps\nspamming  ", source: "profile" });
    assert.equal(result.reportId, 1);
    const [report] = store.reports;
    assert.equal(report.reporterUserId, ALICE);
    assert.equal(report.targetUserId, BOB);
    assert.equal(report.targetName, "Bob");
    assert.equal(report.status, "open");
    assert.equal(report.comment, "keeps spamming");
    assert.equal(report.messageId, null);
  });

  it("cannot report yourself or an unknown player", async () => {
    const { service } = setup();
    assert.equal((await codeOf(service.report(ALICE, { targetUserId: ALICE, category: "spam", source: "profile" }))).error, "REPORT_SELF");
    assert.equal((await codeOf(service.report(ALICE, { targetUserId: "ghost", category: "spam", source: "profile" }))).error, "REPORT_TARGET_NOT_FOUND");
  });

  it("validates the category against the config", async () => {
    const { service } = setup({ categories: ["spam", "cheating"] });
    assert.equal((await codeOf(service.report(ALICE, { targetUserId: BOB, category: "offensive", source: "profile" }))).error, "REPORT_CATEGORY_INVALID");
    assert.equal((await codeOf(service.report(ALICE, { targetUserId: BOB, category: "nonsense", source: "profile" }))).error, "REPORT_CATEGORY_INVALID");
    await service.report(ALICE, { targetUserId: BOB, category: "cheating", source: "arena" });
  });

  it("is refused while reports are disabled", async () => {
    const { service } = setup({ enabled: false });
    assert.equal((await codeOf(service.report(ALICE, { targetUserId: BOB, category: "spam", source: "profile" }))).error, "REPORTS_DISABLED");
  });

  it("allows one open report per reporter and target, a new one after it was handled", async () => {
    const { service, store } = setup();
    await service.report(ALICE, { targetUserId: BOB, category: "spam", source: "profile" });
    assert.equal((await codeOf(service.report(ALICE, { targetUserId: BOB, category: "offensive", source: "profile" }))).error, "REPORT_DUPLICATE");
    await service.report(ALICE, { targetUserId: CARL, category: "spam", source: "profile" });
    await service.report(CARL, { targetUserId: BOB, category: "spam", source: "profile" });

    store.reports[0].status = "resolved";
    await service.report(ALICE, { targetUserId: BOB, category: "offensive", source: "profile" });
    assert.equal(store.reports.length, 4);
  });

  it("maps a unique-index violation (concurrent duplicate) to REPORT_DUPLICATE", async () => {
    const { service, store } = setup();
    store.duplicateOnInsert = true;
    assert.equal((await codeOf(service.report(ALICE, { targetUserId: BOB, category: "spam", source: "profile" }))).error, "REPORT_DUPLICATE");
  });

  it("enforces the cooldown between reports", async () => {
    const { service, clock } = setup({ cooldownSeconds: 60 });
    await service.report(ALICE, { targetUserId: BOB, category: "spam", source: "profile" });
    const refused = await codeOf(service.report(ALICE, { targetUserId: CARL, category: "spam", source: "profile" }));
    assert.equal(refused.error, "REPORT_COOLDOWN");
    assert.equal(refused.fields?.retryAfterSeconds, 60);

    clock.set(T0 + 61_000);
    await service.report(ALICE, { targetUserId: CARL, category: "spam", source: "profile" });
  });

  it("enforces the daily limit on a rolling 24 hours", async () => {
    const { service, store, clock } = setup({ dailyLimit: 2 });
    store.addUser("d1").addUser("d2").addUser("d3");
    await service.report(ALICE, { targetUserId: "d1", category: "spam", source: "profile" });
    await service.report(ALICE, { targetUserId: "d2", category: "spam", source: "profile" });
    const refused = await codeOf(service.report(ALICE, { targetUserId: "d3", category: "spam", source: "profile" }));
    assert.equal(refused.error, "REPORT_LIMIT");
    assert.equal(refused.fields?.dailyLimit, 2);
    // Another reporter is unaffected.
    await service.report(BOB, { targetUserId: "d3", category: "spam", source: "profile" });

    clock.set(T0 + 25 * 3600 * 1000);
    await service.report(ALICE, { targetUserId: "d3", category: "spam", source: "profile" });
  });

  describe("Chat evidence", () => {
    const line = (id: number, userId: string, message: string, ref: string, minutes: number) =>
      ({ id, userId, nickname: userId, message, ref, createdAt: new Date(T0 - minutes * 60_000) });

    it("copies the reported line and the target's recent lines from the stored history", async () => {
      const { service, store } = setup({ historyLines: 2 });
      store.globalLines.push(line(10, BOB, "old line", "0", 30), line(11, BOB, "insult here", "0", 5), line(12, CARL, "unrelated", "0", 4));
      store.guildLines.push(line(5, BOB, "guild chatter", "g1", 1));

      const result = await service.report(ALICE, { messageId: 11, category: "offensive", comment: "he insulted me", source: "global_chat" });
      const report = store.reports.find((r) => r.id === result.reportId)!;
      assert.equal(report.targetUserId, BOB, "the target is the sender of the stored line");
      assert.equal(report.messageId, 11);
      assert.equal(report.messageText, "insult here");
      assert.equal(report.sourceRef, "0");
      assert.deepEqual(report.context.map((l) => [l.source, l.text]), [["guild", "guild chatter"], ["global", "insult here"]]);
    });

    it("evidence is the original (unmasked) text when the word filter masked the stored line", async () => {
      // The Drizzle repository builds the reported line and the context lines through this helper.
      assert.equal(reportEvidenceText({ message: "you are ****", originalMessage: "you are shit" }), "you are shit");
      assert.equal(reportEvidenceText({ message: "plain line", originalMessage: null }), "plain line");

      const { service, store } = setup({ historyLines: 2 });
      const stored = { message: "you are ****", originalMessage: "you are shit" };
      store.globalLines.push({ id: 20, userId: BOB, nickname: BOB, message: reportEvidenceText(stored), ref: "0", createdAt: new Date(T0 - 60_000) });
      const result = await service.report(ALICE, { messageId: 20, category: "offensive", source: "global_chat" });
      const report = store.reports.find((r) => r.id === result.reportId)!;
      assert.equal(report.messageText, "you are shit");
    });

    it("rejects a line that does not belong to the named target, or does not exist", async () => {
      const { service, store } = setup();
      store.globalLines.push(line(11, BOB, "x", "0", 5));
      assert.equal((await codeOf(service.report(ALICE, { targetUserId: CARL, messageId: 11, category: "spam", source: "global_chat" }))).error, "REPORT_MESSAGE_NOT_FOUND");
      assert.equal((await codeOf(service.report(ALICE, { messageId: 999, category: "spam", source: "global_chat" }))).error, "REPORT_MESSAGE_NOT_FOUND");
      // The line's sender can be named explicitly too.
      await service.report(ALICE, { targetUserId: BOB, messageId: 11, category: "spam", source: "global_chat" });
    });

    it("guild chat lines are only reportable by members of that guild", async () => {
      const { service, store } = setup({}, { [ALICE]: "g1", [CARL]: "g2" });
      store.guildLines.push(line(7, BOB, "guild insult", "g1", 2));

      await service.report(ALICE, { messageId: 7, category: "offensive", source: "guild_chat" });
      assert.equal((await codeOf(service.report(CARL, { messageId: 7, category: "offensive", source: "guild_chat" }))).error, "REPORT_MESSAGE_NOT_FOUND");
      assert.equal((await codeOf(service.report("alice2", { messageId: 7, category: "offensive", source: "guild_chat" }))).error, "REPORT_MESSAGE_NOT_FOUND");
    });

    it("private messages are only reportable by their recipient", async () => {
      const { service, store } = setup();
      // `ref` of a private line is its recipient.
      store.directLines.push(line(31, BOB, "private insult", ALICE, 2));

      const result = await service.report(ALICE, { messageId: 31, category: "offensive", source: "private_chat" });
      const report = store.reports.find((r) => r.id === result.reportId)!;
      assert.equal(report.messageText, "private insult");
      assert.equal(report.source, "private_chat");
      assert.equal((await codeOf(service.report(CARL, { messageId: 31, category: "offensive", source: "private_chat" }))).error, "REPORT_MESSAGE_NOT_FOUND");
      assert.equal((await codeOf(service.report(ALICE, { messageId: 31, category: "spam", source: "guild_chat" }))).error, "REPORT_MESSAGE_NOT_FOUND");
    });

    it("never takes text from the client: the payload schema rejects text fields", () => {
      assert.equal(ReportPlayerSchema.safeParse({ targetUserId: BOB, category: "spam", source: "profile", messageText: "forged" }).success, false);
      assert.equal(ReportPlayerSchema.safeParse({ targetUserId: BOB, category: "spam", source: "profile", reporterUserId: BOB }).success, false);
      assert.equal(ReportPlayerSchema.safeParse({ targetUserId: BOB, category: "spam", source: "profile", comment: "x".repeat(301) }).success, false);
      assert.equal(ReportPlayerSchema.safeParse({ targetUserId: BOB, category: "spam", source: "nowhere" }).success, false);
      assert.equal(ReportPlayerSchema.safeParse({ messageId: 3, category: "spam", source: "guild_chat" }).success, true);
    });

    it("needs a target or a message, and a chat source for a message id", async () => {
      const { service } = setup();
      assert.equal((await codeOf(service.report(ALICE, { category: "spam", source: "profile" }))).error, "INVALID_PAYLOAD");
      assert.equal((await codeOf(service.report(ALICE, { targetUserId: BOB, messageId: 1, category: "spam", source: "profile" }))).error, "INVALID_PAYLOAD");
    });

    it("keeps no context when historyLines is 0", async () => {
      const { service, store } = setup({ historyLines: 0 });
      store.globalLines.push(line(11, BOB, "x", "0", 5));
      await service.report(ALICE, { messageId: 11, category: "spam", source: "global_chat" });
      assert.deepEqual(store.reports[0].context, []);
    });
  });
});

describe("Report rules config", () => {
  it("falls back to the defaults and clamps values", () => {
    assert.deepEqual(normalizeReportRules(undefined), DEFAULT_REPORT_RULES);
    const rules = normalizeReportRules({ dailyLimit: -5, cooldownSeconds: "12", categories: ["spam", "bogus"], historyLines: 500, notifyReporter: false, enabled: false });
    assert.equal(rules.dailyLimit, 1);
    assert.equal(rules.cooldownSeconds, 12);
    assert.deepEqual(rules.categories, ["spam"]);
    assert.equal(rules.historyLines, 20);
    assert.equal(rules.notifyReporter, false);
    assert.equal(rules.enabled, false);
    assert.deepEqual(normalizeReportRules({ categories: ["bogus"] }).categories, DEFAULT_REPORT_RULES.categories);
  });
});
