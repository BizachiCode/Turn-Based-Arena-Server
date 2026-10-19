// GM panel "Reports": the queue of player reports and the moderator decisions on them. Resolving applies the chosen
// sanction through the existing player tools (warn by mail, mute, kick, ban), marks the report(s) handled and audits
// the decision on the target's trail; dismissing only closes the report. Every decision is idempotent per report:
// a report is claimed with `WHERE status = 'open'`, so two moderators never apply the same decision twice.

import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { createLogger } from "../../shared/logger.js";
import type { MailDraft } from "../mail/mail.service.js";
import type { ReportAction, ReportRules } from "../report/report.rules.js";
import type { AdminUserDirectory } from "./admin.ports.js";
import type {
  AdminReportDetail,
  AdminReportList,
  AdminReportQuery,
  AdminReportRepository,
  AdminStoredReport,
} from "./admin-reports.ports.js";
import { AdminPlayerError } from "./admin-players.service.js";

const logger = createLogger("AdminReports");

/** The sanctions of `AdminPlayersService` the reports reuse. */
export interface ReportSanctions {
  mute(selector: string, until: Date | null, reason?: string): Promise<{ userId: string; until: string }>;
  kick(selector: string, reason?: string): Promise<{ userId: string; connections: number }>;
  ban(selector: string, until: Date | null, reason?: string): Promise<{ userId: string; until: string | null; connections: number }>;
}

/** GM mail to the reported player (`AdminPlayerEditsService.sendMail`, audited as `GM_MAIL`). */
export interface ReportWarnings {
  sendMail(selector: string, draft: MailDraft, reason?: string): Promise<{ userId: string }>;
}

/** Plain mail to the reporter (`MailService.send`), idempotent per `receiptKey`. */
export interface ReporterMailer {
  send(userId: string, draft: MailDraft, options?: { receiptKey?: string }): Promise<boolean>;
}

export type AdminReportsDeps = {
  repo: AdminReportRepository;
  sanctions: ReportSanctions;
  warnings: ReportWarnings;
  mailer: ReporterMailer;
  users: AdminUserDirectory;
  audit: AuditLog;
  clock: Clock;
  rules: () => ReportRules;
};

export type ResolveInput = {
  action: ReportAction;
  /** `mute`: hours (1..8760). */
  muteHours?: number;
  /** `ban`: days (1..3650); absent / null = permanent. */
  banDays?: number | null;
  /** Shown to the player (warn mail body, kick / ban reason). */
  message?: string;
  /** Internal note kept on the report and in the audit trail. */
  note?: string;
};

export type ReportDecision = {
  userId: string;
  reportIds: number[];
  status: "resolved" | "dismissed";
  action: ReportAction;
  /** Reporters that got the "thanks" mail. */
  notified: number;
};

const DEFAULT_WARNING = "Your behavior was reported and reviewed by our team. Please follow the community rules; further violations may lead to a mute or a ban.";

function clean(value: unknown, max = 255): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, max) : "";
  return text.length > 0 ? text : null;
}

export class AdminReportsService {
  constructor(private readonly deps: AdminReportsDeps) {}

  list(input: Partial<AdminReportQuery>): Promise<AdminReportList & { page: number; pageSize: number }> {
    const query: AdminReportQuery = {
      tab: input.tab ?? "open",
      q: input.q?.trim() || null,
      sort: input.sort ?? "created",
      dir: input.dir ?? "desc",
      page: Math.max(1, Math.floor(input.page ?? 1)),
      pageSize: Math.max(1, Math.min(100, Math.floor(input.pageSize ?? 25))),
      targetUserId: input.targetUserId ?? null,
      reporterUserId: input.reporterUserId ?? null,
    };
    return this.deps.repo.list(query).then((list) => ({ ...list, page: query.page, pageSize: query.pageSize }));
  }

  /** Reports waiting for a decision (sidebar badge). */
  openCount(): Promise<number> {
    return this.deps.repo.countOpen();
  }

  async detail(id: number): Promise<AdminReportDetail> {
    const report = await this.deps.repo.find(id);
    if (!report) throw new AdminPlayerError("Report not found.");
    const [target, related, sanctions] = await Promise.all([
      this.deps.repo.targetState(report.target.userId as string, this.deps.clock.now()),
      this.deps.repo.relatedTo(report.target.userId as string, id, 25),
      this.deps.repo.sanctions(report.target.userId as string, 30),
    ]);
    return {
      report,
      target: target ?? { userId: report.target.userId as string, username: report.target.username, name: report.target.name, level: null, banned: false, muted: false },
      related,
      sanctions,
    };
  }

  /** Resolves one open report, optionally applying a sanction to the target. */
  async resolve(id: number, input: ResolveInput): Promise<ReportDecision> {
    const report = await this.openReport(id);
    return this.decide(report.target.userId as string, [report], "resolved", input);
  }

  async dismiss(id: number, note?: string): Promise<ReportDecision> {
    const report = await this.openReport(id);
    return this.decide(report.target.userId as string, [report], "dismissed", { action: "none", note });
  }

  /** Resolves every open report against one player with a single sanction. */
  async resolveTarget(selector: string, input: ResolveInput): Promise<ReportDecision> {
    const { userId, reports } = await this.openAgainst(selector);
    return this.decide(userId, reports, "resolved", input);
  }

  async dismissTarget(selector: string, note?: string): Promise<ReportDecision> {
    const { userId, reports } = await this.openAgainst(selector);
    return this.decide(userId, reports, "dismissed", { action: "none", note });
  }

  private async openReport(id: number): Promise<AdminStoredReport> {
    const report = await this.deps.repo.find(id);
    if (!report) throw new AdminPlayerError("Report not found.");
    if (report.status !== "open") throw new AdminPlayerError("The report was already handled.");
    return report;
  }

  private async openAgainst(selector: string): Promise<{ userId: string; reports: AdminStoredReport[] }> {
    const value = String(selector || "").trim();
    const user = value ? await this.deps.users.resolve(value) : null;
    if (!user) throw new AdminPlayerError("Player not found.");
    const reports = await this.deps.repo.openAgainst(user.userId);
    if (reports.length === 0) throw new AdminPlayerError("The player has no open reports.");
    return { userId: user.userId, reports };
  }

  private async decide(
    targetUserId: string,
    reports: AdminStoredReport[],
    status: "resolved" | "dismissed",
    input: ResolveInput,
  ): Promise<ReportDecision> {
    const action: ReportAction = status === "resolved" ? input.action : "none";
    const note = clean(input.note);
    const message = clean(input.message);
    const muteHours = Math.floor(Number(input.muteHours ?? 0));
    const banDays = input.banDays === null || input.banDays === undefined ? null : Math.floor(Number(input.banDays));
    if (action === "mute" && !(muteHours >= 1 && muteHours <= 24 * 365)) throw new AdminPlayerError("Mute hours must be between 1 and 8760.");
    if (action === "ban" && banDays !== null && !(banDays >= 1 && banDays <= 3650)) throw new AdminPlayerError("Ban days must be between 1 and 3650 (empty = permanent).");

    const now = this.deps.clock.now();
    const claimedIds = await this.deps.repo.claim(reports.map((report) => report.id), { status, action, note, at: now });
    if (claimedIds.length === 0) throw new AdminPlayerError("The report was already handled.");
    const claimed = reports.filter((report) => claimedIds.includes(report.id));

    try {
      await this.applySanction(targetUserId, claimed, action, { muteHours, banDays, message, note });
    } catch (error) {
      await this.deps.repo.reopen(claimedIds);
      throw error;
    }

    await this.deps.audit.record({
      userId: targetUserId,
      kind: status === "resolved" ? "GM_REPORT_RESOLVE" : "GM_REPORT_DISMISS",
      meta: {
        reportIds: claimedIds,
        action,
        note,
        categories: [...new Set(claimed.map((report) => report.category))],
        ...(action === "mute" ? { muteHours } : {}),
        ...(action === "ban" ? { banDays } : {}),
      },
    });

    const notified = status === "resolved" && action !== "none" ? await this.notifyReporters(claimed) : 0;
    return { userId: targetUserId, reportIds: claimedIds, status, action, notified };
  }

  private async applySanction(
    targetUserId: string,
    reports: AdminStoredReport[],
    action: ReportAction,
    options: { muteHours: number; banDays: number | null; message: string | null; note: string | null },
  ): Promise<void> {
    if (action === "none") return;
    const categories = [...new Set(reports.map((report) => report.category))];
    const reason = options.message ?? `Community rules violation (${categories.join(", ")}).`;
    const nowMs = this.deps.clock.nowMs();

    switch (action) {
      case "warn":
        await this.deps.warnings.sendMail(
          targetUserId,
          { title: "Warning", body: options.message ?? DEFAULT_WARNING, sender: "Game Master", expirationDays: 30 },
          options.note ?? "report",
        );
        return;
      case "mute":
        await this.deps.sanctions.mute(targetUserId, new Date(nowMs + options.muteHours * 3600 * 1000), reason);
        return;
      case "kick":
        await this.deps.sanctions.kick(targetUserId, reason);
        return;
      case "ban":
        await this.deps.sanctions.ban(targetUserId, options.banDays === null ? null : new Date(nowMs + options.banDays * 86_400_000), reason);
        return;
    }
  }

  /** "Thanks, action was taken" mail to each reporter (once per report; failures never undo the decision). */
  private async notifyReporters(reports: AdminStoredReport[]): Promise<number> {
    if (!this.deps.rules().notifyReporter) return 0;
    let sent = 0;
    for (const report of reports) {
      const reporterId = report.reporter.userId;
      if (!reporterId) continue;
      try {
        const delivered = await this.deps.mailer.send(reporterId, {
          category: "system",
          sender: "Game Master",
          title: "Report reviewed",
          body: "Thank you for your report. Our team reviewed it and took action.",
          titleKey: "text_mail_report_handled_title",
          bodyKey: "text_mail_report_handled_body",
          expirationDays: 14,
        }, { receiptKey: `report:${report.id}` });
        if (delivered) sent++;
      } catch (error) {
        logger.warn("reporter mail failed:", (error as Error).message);
      }
    }
    return sent;
  }
}
