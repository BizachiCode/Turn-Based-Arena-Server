// GM panel "Reports": read models and the status transitions of `player_reports`. The sanctions themselves are the
// existing `AdminPlayersService` actions (mute, kick, ban) and the GM mail.

import type { ReportContextLine } from "../report/report.ports.js";
import type { ReportAction, ReportStatus } from "../report/report.rules.js";

export const REPORT_TABS = ["open", "resolved", "dismissed", "all"] as const;
export type AdminReportTab = typeof REPORT_TABS[number];
export const REPORT_SORTS = ["created", "category", "reporter", "target", "status"] as const;
export type AdminReportSort = typeof REPORT_SORTS[number];

export type AdminReportQuery = {
  tab: AdminReportTab;
  /** Substring of a reporter / target username, profile name or id. */
  q: string | null;
  sort: AdminReportSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
  /** Reports filed against / by one account (the player page tabs). */
  targetUserId: string | null;
  reporterUserId: string | null;
};

export type AdminReportPlayer = { userId: string | null; username: string | null; name: string | null };

export type AdminReportRow = {
  id: number;
  status: ReportStatus;
  category: string;
  source: string;
  comment: string;
  reporter: AdminReportPlayer;
  target: AdminReportPlayer & { name: string };
  /** Open reports against the same target (this one included while open). */
  openAgainstTarget: number;
  createdAt: string;
  handledAt: string | null;
  resolutionAction: string | null;
};

export type AdminReportList = {
  rows: AdminReportRow[];
  /** Rows matching tab, search and filters (before paging). */
  total: number;
  /** Reports per tab (search ignored). */
  counts: Record<AdminReportTab, number>;
};

/** A report as stored (ids only; names are joined by the repository). */
export type AdminStoredReport = AdminReportRow & {
  sourceRef: string | null;
  messageId: number | null;
  messageText: string | null;
  context: ReportContextLine[];
  resolutionNote: string | null;
};

export type AdminReportSanction = { id: number; kind: string; meta: unknown; createdAt: string };

export type AdminReportDetail = {
  report: AdminStoredReport;
  target: {
    userId: string;
    username: string | null;
    name: string;
    level: number | null;
    banned: boolean;
    muted: boolean;
  };
  /** Other reports against the same target, newest first. */
  related: AdminReportRow[];
  /** Moderation history of the target (bans, mutes, kicks, GM mails, handled reports). */
  sanctions: AdminReportSanction[];
};

export type ReportOutcome = {
  status: Exclude<ReportStatus, "open">;
  action: ReportAction;
  note: string | null;
  at: Date;
};

export interface AdminReportRepository {
  list(query: AdminReportQuery): Promise<AdminReportList>;
  countOpen(): Promise<number>;
  find(id: number): Promise<AdminStoredReport | null>;
  /** Other reports against `targetUserId` (any status), newest first. */
  relatedTo(targetUserId: string, excludeId: number, limit: number): Promise<AdminReportRow[]>;
  /** Open reports against one account (oldest first). */
  openAgainst(targetUserId: string): Promise<AdminStoredReport[]>;
  /** Marks the given reports handled when they are still open; returns the ids that were (guards double handling). */
  claim(ids: number[], outcome: ReportOutcome): Promise<number[]>;
  /** Puts claimed reports back to open (a sanction failed after the claim). */
  reopen(ids: number[]): Promise<void>;
  targetState(userId: string, now: Date): Promise<AdminReportDetail["target"] | null>;
  sanctions(userId: string, limit: number): Promise<AdminReportSanction[]>;
}
