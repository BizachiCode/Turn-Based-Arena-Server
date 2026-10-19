import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { chatMessages, directMessages, guildChatMessages, playerReports, userProfile, users } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { NewReport, ReportContextLine, ReportRepository, ReportedLine } from "./report.ports.js";
import { reportEvidenceText } from "./report.rules.js";

export class DrizzleReportRepository extends DrizzleRepository implements ReportRepository {
  constructor(database: Database) {
    super(database);
  }

  async lockReporter(userId: string, session: DbSession): Promise<void> {
    await this.db(session).select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
  }

  async findTarget(userId: string): Promise<{ userId: string; name: string } | null> {
    const [row] = await this.database
      .select({ userId: users.id, username: users.username, name: userProfile.name })
      .from(users)
      .leftJoin(userProfile, eq(userProfile.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    return row ? { userId: row.userId, name: row.name ?? row.username } : null;
  }

  async findGlobalLine(id: number): Promise<ReportedLine | null> {
    const [row] = await this.database.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
    return row
      ? { id: row.id, userId: row.userId, nickname: row.nickname, message: reportEvidenceText(row), ref: String(row.channel), createdAt: row.createdAt }
      : null;
  }

  async findGuildLine(id: number): Promise<ReportedLine | null> {
    const [row] = await this.database.select().from(guildChatMessages)
      .where(and(eq(guildChatMessages.id, id), eq(guildChatMessages.kind, "user"), isNotNull(guildChatMessages.userId))).limit(1);
    return row
      ? { id: row.id, userId: row.userId, nickname: row.nickname, message: reportEvidenceText(row), ref: row.guildId, createdAt: row.createdAt }
      : null;
  }

  async findDirectLine(id: number): Promise<ReportedLine | null> {
    const [row] = await this.database
      .select({ id: directMessages.id, userId: directMessages.senderId, recipientId: directMessages.recipientId, nickname: userProfile.name,
        message: directMessages.message, originalMessage: directMessages.originalMessage, createdAt: directMessages.createdAt })
      .from(directMessages)
      .leftJoin(userProfile, eq(userProfile.userId, directMessages.senderId))
      .where(eq(directMessages.id, id)).limit(1);
    return row
      ? { id: row.id, userId: row.userId, nickname: row.nickname ?? "", message: reportEvidenceText(row), ref: row.recipientId, createdAt: row.createdAt }
      : null;
  }

  async recentLines(userId: string, limit: number): Promise<ReportContextLine[]> {
    const take = Math.max(1, Math.min(20, limit));
    const [global, guild] = await Promise.all([
      this.database.select().from(chatMessages).where(eq(chatMessages.userId, userId)).orderBy(desc(chatMessages.id)).limit(take),
      this.database.select().from(guildChatMessages)
        .where(and(eq(guildChatMessages.userId, userId), eq(guildChatMessages.kind, "user"))).orderBy(desc(guildChatMessages.id)).limit(take),
    ]);
    const lines: Array<ReportContextLine & { at: string }> = [
      ...global.map((row) => ({ source: "global" as const, id: row.id, ref: String(row.channel), text: reportEvidenceText(row), at: row.createdAt.toISOString() })),
      ...guild.map((row) => ({ source: "guild" as const, id: row.id, ref: row.guildId, text: reportEvidenceText(row), at: row.createdAt.toISOString() })),
    ];
    return lines.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, take);
  }

  async hasOpenReport(reporterUserId: string, targetUserId: string, session: DbSession): Promise<boolean> {
    const [row] = await this.db(session).select({ id: playerReports.id }).from(playerReports)
      .where(and(eq(playerReports.reporterUserId, reporterUserId), eq(playerReports.targetUserId, targetUserId), eq(playerReports.status, "open")))
      .limit(1);
    return !!row;
  }

  async lastReportAt(reporterUserId: string, session: DbSession): Promise<Date | null> {
    const [row] = await this.db(session).select({ at: playerReports.createdAt }).from(playerReports)
      .where(eq(playerReports.reporterUserId, reporterUserId)).orderBy(desc(playerReports.id)).limit(1);
    return row?.at ?? null;
  }

  async countSince(reporterUserId: string, since: Date, session: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ total: sql<number>`count(*)` }).from(playerReports)
      .where(and(eq(playerReports.reporterUserId, reporterUserId), gte(playerReports.createdAt, since)));
    return Number(row?.total ?? 0);
  }

  async insert(report: NewReport, session: DbSession): Promise<number> {
    const [inserted] = await this.db(session).insert(playerReports).values({
      reporterUserId: report.reporterUserId,
      targetUserId: report.targetUserId,
      targetName: report.targetName,
      category: report.category,
      comment: report.comment,
      source: report.source,
      sourceRef: report.sourceRef,
      messageId: report.messageId,
      messageText: report.messageText,
      contextJson: report.context,
      status: "open",
      openSlot: 1,
    }).$returningId();
    return Number(inserted?.id ?? 0);
  }
}
