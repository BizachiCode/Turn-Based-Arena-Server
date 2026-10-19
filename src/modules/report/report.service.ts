// Player reports (player side): `report_player` validates the rules (self, target, duplicates, cooldown, daily limit),
// copies the reported line and the target's recent lines FROM THE SERVER'S STORED CHAT HISTORY (the client only names
// ids, never text) and stores an open report for the GM panel. The reporter is always the session user.

import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { ReportContextLine, ReportRepository, ReportedLine } from "./report.ports.js";
import { REPORT_CATEGORIES, REPORT_COMMENT_MAX, type ReportCategory, type ReportRules, type ReportSource } from "./report.rules.js";

export type ReportServiceDeps = {
  repo: ReportRepository;
  uow: UnitOfWork;
  clock: Clock;
  rules: () => ReportRules;
  /** The player's current guild id (null without one); guild chat lines are only reportable by fellow members. */
  guildOf: (userId: string) => Promise<string | null>;
};

export type ReportPlayerInput = {
  /** Optional when `messageId` names a line: its sender is then the target. */
  targetUserId?: string;
  category: string;
  comment?: string;
  messageId?: number;
  source: ReportSource;
};

const DAY_MS = 24 * 3600 * 1000;

function cleanComment(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, REPORT_COMMENT_MAX);
}

export class ReportService {
  constructor(private readonly deps: ReportServiceDeps) {}

  /** Tuning the client may show (categories, limits). */
  rules(): ReportRules {
    return this.deps.rules();
  }

  async report(reporterUserId: string, input: ReportPlayerInput): Promise<{ reportId: number }> {
    const rules = this.deps.rules();
    if (!rules.enabled) throw new AppError(ErrorCode.REPORTS_DISABLED);
    if (!(rules.categories as readonly string[]).includes(input.category) || !(REPORT_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new AppError(ErrorCode.REPORT_CATEGORY_INVALID);
    }
    const category = input.category as ReportCategory;

    const chatSource = input.source === "global_chat" || input.source === "guild_chat" || input.source === "private_chat";
    if (input.messageId !== undefined && !chatSource) throw new AppError(ErrorCode.INVALID_PAYLOAD);
    if (input.messageId === undefined && !input.targetUserId) throw new AppError(ErrorCode.INVALID_PAYLOAD);

    // The reported line comes from the server's history; it must belong to the target and, for guild chat, to the
    // reporter's own guild, for private chat to a message sent to the reporter (nobody can use a report to pull lines
    // out of a channel or conversation they cannot read).
    let line: ReportedLine | null = null;
    if (input.messageId !== undefined) {
      line = await this.findLine(reporterUserId, input.source, input.messageId);
      if (!line || !line.userId) throw new AppError(ErrorCode.REPORT_MESSAGE_NOT_FOUND);
      if (input.targetUserId && input.targetUserId !== line.userId) throw new AppError(ErrorCode.REPORT_MESSAGE_NOT_FOUND);
    }

    const targetUserId = (line?.userId ?? input.targetUserId) as string;
    if (targetUserId === reporterUserId) throw new AppError(ErrorCode.REPORT_SELF);
    const target = await this.deps.repo.findTarget(targetUserId);
    if (!target) throw new AppError(ErrorCode.REPORT_TARGET_NOT_FOUND);

    const context: ReportContextLine[] = rules.historyLines > 0 ? await this.deps.repo.recentLines(targetUserId, rules.historyLines) : [];
    const comment = cleanComment(input.comment);
    const nowMs = this.deps.clock.nowMs();

    try {
      const reportId = await this.deps.uow.transaction(async (session) => {
        await this.deps.repo.lockReporter(reporterUserId, session);

        if (await this.deps.repo.hasOpenReport(reporterUserId, targetUserId, session)) throw new AppError(ErrorCode.REPORT_DUPLICATE);

        const last = await this.deps.repo.lastReportAt(reporterUserId, session);
        if (last && rules.cooldownSeconds > 0) {
          const retryAfter = Math.ceil((last.getTime() + rules.cooldownSeconds * 1000 - nowMs) / 1000);
          if (retryAfter > 0) throw new AppError(ErrorCode.REPORT_COOLDOWN, { fields: { retryAfterSeconds: retryAfter } });
        }

        const sent = await this.deps.repo.countSince(reporterUserId, new Date(nowMs - DAY_MS), session);
        if (sent >= rules.dailyLimit) throw new AppError(ErrorCode.REPORT_LIMIT, { fields: { dailyLimit: rules.dailyLimit } });

        return this.deps.repo.insert({
          reporterUserId,
          targetUserId,
          targetName: target.name.slice(0, 64),
          category,
          comment,
          source: input.source,
          sourceRef: line?.ref ?? null,
          messageId: line?.id ?? null,
          messageText: line ? line.message.slice(0, 300) : null,
          context,
        }, session);
      });
      return { reportId };
    } catch (error) {
      // The unique (reporter, target, open) index closes the race the lock above already makes unlikely.
      if (isDuplicateKeyError(error)) throw new AppError(ErrorCode.REPORT_DUPLICATE);
      throw error;
    }
  }

  private async findLine(reporterUserId: string, source: ReportSource, messageId: number): Promise<ReportedLine | null> {
    if (source === "global_chat") return this.deps.repo.findGlobalLine(messageId);
    if (source === "private_chat") {
      const direct = await this.deps.repo.findDirectLine(messageId);
      return direct && direct.ref === reporterUserId ? direct : null;
    }
    const line = await this.deps.repo.findGuildLine(messageId);
    if (!line) return null;
    const guildId = await this.deps.guildOf(reporterUserId);
    return guildId && guildId === line.ref ? line : null;
  }
}
