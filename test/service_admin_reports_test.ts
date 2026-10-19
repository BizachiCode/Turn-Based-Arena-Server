import assert from "node:assert/strict";

import type { AdminUserDirectory, AdminUserRef } from "../src/modules/admin/admin.ports";
import { AdminPlayerError } from "../src/modules/admin/admin-players.service";
import { AdminReportsService, type ResolveInput } from "../src/modules/admin/admin-reports.service";
import type { MailDraft } from "../src/modules/mail/mail.service";
import { DEFAULT_REPORT_RULES, type ReportRules } from "../src/modules/report/report.rules";
import { ReportService } from "../src/modules/report/report.service";
import type { AuditEntry, AuditLog } from "../src/shared/kernel/audit";
import { FixedClock } from "../src/shared/kernel/clock";
import { InMemoryUnitOfWork } from "./support/fakes";
import { InMemoryReportStore } from "./support/report-fakes";

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3600 * 1000;

function setup(rules: Partial<ReportRules> = {}) {
  const clock = new FixedClock(T0);
  const store = new InMemoryReportStore(clock);
  for (const id of ["alice", "bob", "carl", "dave"]) store.addUser(id, id[0].toUpperCase() + id.slice(1));

  const effective = (): ReportRules => ({ ...DEFAULT_REPORT_RULES, categories: [...DEFAULT_REPORT_RULES.categories], cooldownSeconds: 0, dailyLimit: 100, ...rules });
  const players = new ReportService({ repo: store, uow: new InMemoryUnitOfWork(), clock, rules: effective, guildOf: async () => null });

  const calls: Array<{ op: string; args: unknown[] }> = [];
  const failures = new Set<string>();
  const run = async <T>(op: string, result: T, ...args: unknown[]): Promise<T> => {
    calls.push({ op, args });
    if (failures.has(op)) throw new AdminPlayerError(`${op} failed`);
    return result;
  };
  const mails: Array<{ userId: string; draft: MailDraft; receiptKey?: string }> = [];
  const audits: AuditEntry[] = [];
  const audit: AuditLog = { record: async (entry) => { audits.push(entry); } };
  const users: AdminUserDirectory = {
    resolve: async (selector): Promise<AdminUserRef | null> => (store.users.has(selector) ? { userId: selector, username: store.users.get(selector)!.username, email: null } : null),
    search: async () => [],
  };

  const gm = new AdminReportsService({
    repo: store,
    sanctions: {
      mute: (selector, until, reason) => run("mute", { userId: selector, until: until?.toISOString() ?? "" }, selector, until, reason),
      kick: (selector, reason) => run("kick", { userId: selector, connections: 1 }, selector, reason),
      ban: (selector, until, reason) => run("ban", { userId: selector, until: until?.toISOString() ?? null, connections: 1 }, selector, until, reason),
    },
    warnings: { sendMail: (selector, draft, reason) => run("warn", { userId: selector }, selector, draft, reason) },
    mailer: { send: async (userId, draft, options) => { mails.push({ userId, draft, receiptKey: options?.receiptKey }); return true; } },
    users,
    audit,
    clock,
    rules: effective,
  });

  const file = (reporter: string, target: string, category = "spam") =>
    players.report(reporter, { targetUserId: target, category, source: "profile" }).then((r) => r.reportId);
  return { clock, store, gm, calls, failures, mails, audits, file };
}

const resolve = (input: Partial<ResolveInput> = {}): ResolveInput => ({ action: "none", ...input });

describe("GM reports", () => {
  it("lists with tab counters, search, sort and paging", async () => {
    const env = setup();
    await env.file("alice", "bob", "spam");
    await env.file("carl", "bob", "offensive");
    await env.file("alice", "dave", "cheating");
    await env.gm.dismiss(3, "nothing there");

    const open = await env.gm.list({ tab: "open" });
    assert.deepEqual(open.counts, { open: 2, resolved: 0, dismissed: 1, all: 3 });
    assert.deepEqual(open.rows.map((r) => r.id), [2, 1], "newest first by default");
    assert.equal(open.rows[0].openAgainstTarget, 2);
    assert.equal(open.rows[0].reporter.name, "Carl");
    assert.equal(open.rows[0].target.name, "Bob");

    assert.deepEqual((await env.gm.list({ tab: "all", q: "dave" })).rows.map((r) => r.id), [3]);
    assert.deepEqual((await env.gm.list({ tab: "all", sort: "created", dir: "asc", pageSize: 2, page: 2 })).rows.map((r) => r.id), [3]);
    assert.deepEqual((await env.gm.list({ tab: "all", reporterUserId: "alice" })).rows.map((r) => r.id), [3, 1]);
    assert.equal(await env.gm.openCount(), 2);
  });

  it("shows the detail with context, the other reports and the sanction history", async () => {
    const env = setup();
    env.store.globalLines.push({ id: 4, userId: "bob", nickname: "Bob", message: "you noob", ref: "0", createdAt: new Date(T0 - 60_000) });
    await env.file("alice", "bob");
    await env.file("carl", "bob", "offensive");
    env.store.sanctionRows.push({ id: 9, kind: "GM_MUTE", meta: { reason: "earlier" }, createdAt: new Date(T0).toISOString() });

    const detail = await env.gm.detail(1);
    assert.equal(detail.report.id, 1);
    assert.deepEqual(detail.report.context.map((l) => l.text), ["you noob"]);
    assert.equal(detail.target.name, "Bob");
    assert.deepEqual(detail.related.map((r) => r.id), [2]);
    assert.equal(detail.sanctions[0].kind, "GM_MUTE");
    await assert.rejects(env.gm.detail(99), AdminPlayerError);
  });

  it("dismisses a report with a note: no sanction, no reporter mail, audited", async () => {
    const env = setup();
    const id = await env.file("alice", "bob");
    const decision = await env.gm.dismiss(id, "not a violation");
    assert.deepEqual([decision.status, decision.action, decision.notified], ["dismissed", "none", 0]);
    const report = env.store.reports[0];
    assert.equal(report.status, "dismissed");
    assert.equal(report.note, "not a violation");
    assert.ok(report.handledAt);
    assert.equal(env.calls.length, 0);
    assert.equal(env.mails.length, 0);
    assert.deepEqual(env.audits.map((a) => [a.kind, a.userId]), [["GM_REPORT_DISMISS", "bob"]]);
    // A dismissed report frees the reporter to report the same player again.
    await env.file("alice", "bob");
  });

  it("resolves with each action through the player tools", async () => {
    const env = setup();
    const warn = await env.file("alice", "bob");
    await env.gm.resolve(warn, resolve({ action: "warn", message: "Please be nice", note: "first strike" }));
    assert.equal(env.calls[0].op, "warn");
    assert.equal((env.calls[0].args[1] as MailDraft).body, "Please be nice");
    assert.equal((env.calls[0].args[1] as MailDraft).category, undefined);

    const mute = await env.file("alice", "carl");
    await env.gm.resolve(mute, resolve({ action: "mute", muteHours: 6 }));
    const muteCall = env.calls.find((c) => c.op === "mute")!;
    assert.equal(muteCall.args[0], "carl");
    assert.equal((muteCall.args[1] as Date).getTime(), T0 + 6 * HOUR);

    const kick = await env.file("alice", "dave");
    await env.gm.resolve(kick, resolve({ action: "kick" }));
    assert.equal(env.calls.find((c) => c.op === "kick")!.args[0], "dave");

    env.store.addUser("erin");
    const ban = await env.file("alice", "erin", "cheating");
    await env.gm.resolve(ban, resolve({ action: "ban", banDays: 7, note: "aimbot" }));
    const banCall = env.calls.find((c) => c.op === "ban")!;
    assert.equal((banCall.args[1] as Date).getTime(), T0 + 7 * 24 * HOUR);
    assert.match(String(banCall.args[2]), /cheating/);

    env.store.addUser("frank");
    const forever = await env.file("alice", "frank");
    await env.gm.resolve(forever, resolve({ action: "ban", banDays: null }));
    assert.equal(env.calls.filter((c) => c.op === "ban")[1].args[1], null, "permanent ban");

    assert.deepEqual(env.store.reports.map((r) => [r.status, r.action]), [
      ["resolved", "warn"], ["resolved", "mute"], ["resolved", "kick"], ["resolved", "ban"], ["resolved", "ban"],
    ]);
  });

  it("resolves without an action (acknowledge only) and does not mail the reporter", async () => {
    const env = setup();
    const id = await env.file("alice", "bob");
    const decision = await env.gm.resolve(id, resolve({ action: "none", note: "handled out of band" }));
    assert.deepEqual([decision.status, decision.action, decision.notified], ["resolved", "none", 0]);
    assert.equal(env.mails.length, 0);
    assert.equal(env.calls.length, 0);
  });

  it("validates the action parameters before touching the report", async () => {
    const env = setup();
    const id = await env.file("alice", "bob");
    await assert.rejects(env.gm.resolve(id, resolve({ action: "mute" })), AdminPlayerError);
    await assert.rejects(env.gm.resolve(id, resolve({ action: "mute", muteHours: 100000 })), AdminPlayerError);
    await assert.rejects(env.gm.resolve(id, resolve({ action: "ban", banDays: 0 })), AdminPlayerError);
    assert.equal(env.store.reports[0].status, "open");
    assert.equal(env.calls.length, 0);
  });

  it("refuses to handle a report twice", async () => {
    const env = setup();
    const id = await env.file("alice", "bob");
    await env.gm.resolve(id, resolve({ action: "kick" }));
    await assert.rejects(env.gm.resolve(id, resolve({ action: "ban", banDays: 1 })), /already handled/);
    await assert.rejects(env.gm.dismiss(id), /already handled/);
    assert.equal(env.calls.filter((c) => c.op === "kick").length, 1);
    assert.equal(env.calls.filter((c) => c.op === "ban").length, 0);
  });

  it("reopens the report when the sanction fails", async () => {
    const env = setup();
    const id = await env.file("alice", "bob");
    env.failures.add("ban");
    await assert.rejects(env.gm.resolve(id, resolve({ action: "ban", banDays: 3 })), /ban failed/);
    assert.equal(env.store.reports[0].status, "open");
    assert.equal(env.store.reports[0].handledAt, null);
    assert.equal(env.audits.length, 0, "a failed decision leaves no audit row");
    env.failures.clear();
    await env.gm.resolve(id, resolve({ action: "kick" }));
    assert.equal(env.store.reports[0].status, "resolved");
  });

  it("mails the reporter once, only when notifyReporter is on and an action was taken", async () => {
    const on = setup({ notifyReporter: true });
    const id = await on.file("alice", "bob");
    const decision = await on.gm.resolve(id, resolve({ action: "mute", muteHours: 1 }));
    assert.equal(decision.notified, 1);
    assert.equal(on.mails[0].userId, "alice");
    assert.equal(on.mails[0].receiptKey, `report:${id}`);
    assert.equal(on.mails[0].draft.titleKey, "text_mail_report_handled_title");

    const off = setup({ notifyReporter: false });
    const second = await off.file("alice", "bob");
    assert.equal((await off.gm.resolve(second, resolve({ action: "mute", muteHours: 1 }))).notified, 0);
    assert.equal(off.mails.length, 0);
  });

  it("bulk resolve applies one sanction to every open report against the target", async () => {
    const env = setup();
    await env.file("alice", "bob", "spam");
    await env.file("carl", "bob", "offensive");
    await env.file("dave", "bob", "cheating");
    await env.file("alice", "carl");

    const decision = await env.gm.resolveTarget("bob", resolve({ action: "mute", muteHours: 24, note: "repeat offender" }));
    assert.deepEqual(decision.reportIds, [1, 2, 3]);
    assert.equal(decision.notified, 3);
    assert.equal(env.calls.filter((c) => c.op === "mute").length, 1, "the sanction is applied once");
    assert.deepEqual(env.store.reports.map((r) => r.status), ["resolved", "resolved", "resolved", "open"]);
    assert.equal(env.audits.filter((a) => a.kind === "GM_REPORT_RESOLVE").length, 1);
    assert.deepEqual((env.audits[0].meta as { reportIds: number[] }).reportIds, [1, 2, 3]);
    await assert.rejects(env.gm.resolveTarget("bob", resolve({ action: "kick" })), /no open reports/);
  });

  it("bulk dismiss closes them all without sanctions", async () => {
    const env = setup();
    await env.file("alice", "bob");
    await env.file("carl", "bob");
    const decision = await env.gm.dismissTarget("bob", "false alarm");
    assert.deepEqual(decision.reportIds, [1, 2]);
    assert.equal(env.calls.length, 0);
    assert.deepEqual(env.store.reports.map((r) => r.status), ["dismissed", "dismissed"]);
    await assert.rejects(env.gm.dismissTarget("ghost"), /Player not found/);
  });
});
