import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { ReportCategory, ReportSource } from "./report.rules.js";

/** A stored chat line (global or guild chat) a report may point at. */
export type ReportedLine = {
  id: number;
  /** Sender (null for guild system lines, which cannot be reported). */
  userId: string | null;
  nickname: string;
  /** What the sender really wrote: the unmasked text when the word filter masked the line. */
  message: string;
  /** Global channel number (global chat), guild id (guild chat) or the recipient's user id (private chat). */
  ref: string;
  createdAt: Date;
};

/** One line of the target's stored chat history copied into a report. */
export type ReportContextLine = {
  source: "global" | "guild";
  id: number;
  /** Channel number or guild id. */
  ref: string;
  /** Original text when the line was masked. */
  text: string;
  at: string;
};

export type NewReport = {
  reporterUserId: string;
  targetUserId: string;
  targetName: string;
  category: ReportCategory;
  comment: string;
  source: ReportSource;
  sourceRef: string | null;
  messageId: number | null;
  messageText: string | null;
  context: ReportContextLine[];
};

/** Persistence of the player-facing report flow (every write scoped by the reporter's session user id). */
export interface ReportRepository {
  /** Row lock on the reporter so concurrent reports of one player are checked one at a time. */
  lockReporter(userId: string, session: DbSession): Promise<void>;
  /** The target account (null when it does not exist) with its display name. */
  findTarget(userId: string): Promise<{ userId: string; name: string } | null>;
  findGlobalLine(id: number): Promise<ReportedLine | null>;
  /** User lines only (system lines are never reportable). */
  findGuildLine(id: number): Promise<ReportedLine | null>;
  /** A private message (`ref` = its recipient). */
  findDirectLine(id: number): Promise<ReportedLine | null>;
  /** The player's newest `limit` stored chat lines across global and guild chat, newest first. */
  recentLines(userId: string, limit: number): Promise<ReportContextLine[]>;
  hasOpenReport(reporterUserId: string, targetUserId: string, session: DbSession): Promise<boolean>;
  lastReportAt(reporterUserId: string, session: DbSession): Promise<Date | null>;
  countSince(reporterUserId: string, since: Date, session: DbSession): Promise<number>;
  insert(report: NewReport, session: DbSession): Promise<number>;
}
