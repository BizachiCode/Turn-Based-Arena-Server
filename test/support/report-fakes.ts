// In-memory report store implementing both the player-facing and the GM repository ports (one shared table).

import type {
  AdminReportDetail,
  AdminReportList,
  AdminReportQuery,
  AdminReportRepository,
  AdminReportRow,
  AdminReportSanction,
  AdminStoredReport,
  ReportOutcome,
} from "../../src/modules/admin/admin-reports.ports";
import type { NewReport, ReportContextLine, ReportRepository, ReportedLine } from "../../src/modules/report/report.ports";
import type { ReportStatus } from "../../src/modules/report/report.rules";
import type { DbSession } from "../../src/shared/kernel/unit-of-work";
import type { FixedClock } from "../../src/shared/kernel/clock";

type StoredReport = NewReport & {
  id: number;
  status: ReportStatus;
  action: string | null;
  note: string | null;
  handledAt: Date | null;
  createdAt: Date;
};

export class InMemoryReportStore implements ReportRepository, AdminReportRepository {
  users = new Map<string, { name: string; username: string }>();
  globalLines: ReportedLine[] = [];
  guildLines: ReportedLine[] = [];
  reports: StoredReport[] = [];
  sanctionRows: AdminReportSanction[] = [];
  /** Test hook: makes the next `insert` fail like the unique (reporter, target, open) index would. */
  duplicateOnInsert = false;
  private nextId = 1;

  constructor(private readonly clock: FixedClock) {}

  addUser(userId: string, name = userId): this {
    this.users.set(userId, { name, username: `${name}_acct` });
    return this;
  }

  // ── ReportRepository ──────────────────────────────────────────────
  async lockReporter(): Promise<void> {}
  async findTarget(userId: string) {
    const user = this.users.get(userId);
    return user ? { userId, name: user.name } : null;
  }
  async findGlobalLine(id: number) {
    return this.globalLines.find((line) => line.id === id) ?? null;
  }
  async findGuildLine(id: number) {
    return this.guildLines.find((line) => line.id === id && line.userId) ?? null;
  }
  directLines: ReportedLine[] = [];
  async findDirectLine(id: number) {
    return this.directLines.find((line) => line.id === id) ?? null;
  }
  async recentLines(userId: string, limit: number): Promise<ReportContextLine[]> {
    const lines = [
      ...this.globalLines.filter((line) => line.userId === userId).map((line) => ({ source: "global" as const, id: line.id, ref: line.ref, text: line.message, at: line.createdAt.toISOString() })),
      ...this.guildLines.filter((line) => line.userId === userId).map((line) => ({ source: "guild" as const, id: line.id, ref: line.ref, text: line.message, at: line.createdAt.toISOString() })),
    ];
    return lines.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, limit);
  }
  async hasOpenReport(reporter: string, target: string, _session: DbSession) {
    return this.reports.some((r) => r.reporterUserId === reporter && r.targetUserId === target && r.status === "open");
  }
  async lastReportAt(reporter: string) {
    const mine = this.reports.filter((r) => r.reporterUserId === reporter);
    return mine.length ? mine[mine.length - 1].createdAt : null;
  }
  async countSince(reporter: string, since: Date) {
    return this.reports.filter((r) => r.reporterUserId === reporter && r.createdAt >= since).length;
  }
  async insert(report: NewReport): Promise<number> {
    if (this.duplicateOnInsert) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY", errno: 1062 });
    const id = this.nextId++;
    this.reports.push({ ...report, id, status: "open", action: null, note: null, handledAt: null, createdAt: this.clock.now() });
    return id;
  }

  // ── AdminReportRepository ─────────────────────────────────────────
  private toStored(report: StoredReport): AdminStoredReport {
    const reporter = this.users.get(report.reporterUserId);
    const target = this.users.get(report.targetUserId);
    return {
      id: report.id,
      status: report.status,
      category: report.category,
      source: report.source,
      comment: report.comment,
      reporter: { userId: report.reporterUserId, username: reporter?.username ?? null, name: reporter?.name ?? null },
      target: { userId: report.targetUserId, username: target?.username ?? null, name: target?.name ?? report.targetName },
      openAgainstTarget: this.reports.filter((r) => r.targetUserId === report.targetUserId && r.status === "open").length,
      createdAt: report.createdAt.toISOString(),
      handledAt: report.handledAt ? report.handledAt.toISOString() : null,
      resolutionAction: report.action,
      sourceRef: report.sourceRef,
      messageId: report.messageId,
      messageText: report.messageText,
      context: report.context,
      resolutionNote: report.note,
    };
  }

  async list(query: AdminReportQuery): Promise<AdminReportList> {
    const scoped = this.reports.filter((r) =>
      (!query.targetUserId || r.targetUserId === query.targetUserId) && (!query.reporterUserId || r.reporterUserId === query.reporterUserId));
    const matches = (r: StoredReport) => !query.q
      || [r.reporterUserId, r.targetUserId, r.targetName, this.users.get(r.reporterUserId)?.name ?? ""].some((v) => v.toLowerCase().includes(query.q!.toLowerCase()));
    const inTab = (r: StoredReport) => query.tab === "all" || r.status === query.tab;
    const rows = scoped.filter((r) => inTab(r) && matches(r)).sort((a, b) => (query.dir === "asc" ? a.id - b.id : b.id - a.id));
    const count = (status?: ReportStatus) => scoped.filter((r) => !status || r.status === status).length;
    return {
      total: rows.length,
      counts: { open: count("open"), resolved: count("resolved"), dismissed: count("dismissed"), all: count() },
      rows: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((r) => this.toSummary(r)),
    };
  }
  private toSummary(report: StoredReport): AdminReportRow {
    const { sourceRef: _a, messageId: _b, messageText: _c, context: _d, resolutionNote: _e, ...rest } = this.toStored(report);
    return rest;
  }
  async countOpen() {
    return this.reports.filter((r) => r.status === "open").length;
  }
  async find(id: number) {
    const report = this.reports.find((r) => r.id === id);
    return report ? this.toStored(report) : null;
  }
  async relatedTo(targetUserId: string, excludeId: number, limit: number) {
    return this.reports.filter((r) => r.targetUserId === targetUserId && r.id !== excludeId).sort((a, b) => b.id - a.id).slice(0, limit).map((r) => this.toSummary(r));
  }
  async openAgainst(targetUserId: string) {
    return this.reports.filter((r) => r.targetUserId === targetUserId && r.status === "open").map((r) => this.toStored(r));
  }
  async claim(ids: number[], outcome: ReportOutcome) {
    const claimed: number[] = [];
    for (const report of this.reports) {
      if (!ids.includes(report.id) || report.status !== "open") continue;
      report.status = outcome.status;
      report.action = outcome.action;
      report.note = outcome.note;
      report.handledAt = outcome.at;
      claimed.push(report.id);
    }
    return claimed;
  }
  async reopen(ids: number[]) {
    for (const report of this.reports) {
      if (!ids.includes(report.id)) continue;
      report.status = "open";
      report.action = null;
      report.note = null;
      report.handledAt = null;
    }
  }
  async targetState(userId: string): Promise<AdminReportDetail["target"] | null> {
    const user = this.users.get(userId);
    return user ? { userId, username: user.username, name: user.name, level: 7, banned: false, muted: false } : null;
  }
  async sanctions() {
    return this.sanctionRows;
  }
}
