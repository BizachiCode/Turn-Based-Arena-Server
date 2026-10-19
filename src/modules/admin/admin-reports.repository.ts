import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { auditEvents, playerReports, userProfile, users } from "../../infrastructure/database/schema/index.js";
import type { ReportContextLine } from "../report/report.ports.js";
import type { ReportStatus } from "../report/report.rules.js";
import { likeContains, parseJsonMeta } from "./admin.repository.js";
import {
  REPORT_TABS,
  type AdminReportDetail,
  type AdminReportList,
  type AdminReportQuery,
  type AdminReportRepository,
  type AdminReportRow,
  type AdminReportSanction,
  type AdminReportTab,
  type AdminStoredReport,
  type ReportOutcome,
} from "./admin-reports.ports.js";

const reporterUser = alias(users, "reporter_user");
const reporterProfile = alias(userProfile, "reporter_profile");
const targetUser = alias(users, "target_user");
const targetProfile = alias(userProfile, "target_profile");

/** Audit kinds that make up a player's moderation history. */
const SANCTION_KINDS = ["BAN", "UNBAN", "GM_KICK", "GM_MUTE", "GM_UNMUTE", "GM_MAIL", "GM_REPORT_RESOLVE", "GM_REPORT_DISMISS"];

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

type ReportSelectRow = Awaited<ReturnType<DrizzleAdminReportRepository["selectRows"]>>[number];

export class DrizzleAdminReportRepository extends DrizzleRepository implements AdminReportRepository {
  constructor(database: Database) {
    super(database);
  }

  /** The report columns plus the joined names and the open-reports-against-target counter. */
  selectRows() {
    return this.database.select({
      id: playerReports.id,
      status: playerReports.status,
      category: playerReports.category,
      source: playerReports.source,
      comment: playerReports.comment,
      sourceRef: playerReports.sourceRef,
      messageId: playerReports.messageId,
      messageText: playerReports.messageText,
      context: playerReports.contextJson,
      resolutionAction: playerReports.resolutionAction,
      resolutionNote: playerReports.resolutionNote,
      handledAt: playerReports.handledAt,
      createdAt: playerReports.createdAt,
      reporterUserId: playerReports.reporterUserId,
      reporterUsername: reporterUser.username,
      reporterName: reporterProfile.name,
      targetUserId: playerReports.targetUserId,
      targetUsername: targetUser.username,
      targetName: playerReports.targetName,
      targetProfileName: targetProfile.name,
      openAgainstTarget: sql<number>`(select count(*) from player_reports pr2 where pr2.target_user_id = ${playerReports.targetUserId} and pr2.status = 'open')`,
    }).from(playerReports)
      .leftJoin(reporterUser, eq(reporterUser.id, playerReports.reporterUserId))
      .leftJoin(reporterProfile, eq(reporterProfile.userId, playerReports.reporterUserId))
      .leftJoin(targetUser, eq(targetUser.id, playerReports.targetUserId))
      .leftJoin(targetProfile, eq(targetProfile.userId, playerReports.targetUserId));
  }

  private toRow(row: ReportSelectRow): AdminStoredReport {
    const context = parseJsonMeta(row.context);
    return {
      id: row.id,
      status: row.status as ReportStatus,
      category: row.category,
      source: row.source,
      comment: row.comment,
      reporter: { userId: row.reporterUserId, username: row.reporterUsername ?? null, name: row.reporterName ?? null },
      target: { userId: row.targetUserId, username: row.targetUsername ?? null, name: row.targetProfileName ?? row.targetName },
      openAgainstTarget: Number(row.openAgainstTarget ?? 0),
      createdAt: row.createdAt.toISOString(),
      handledAt: iso(row.handledAt),
      resolutionAction: row.resolutionAction ?? null,
      sourceRef: row.sourceRef ?? null,
      messageId: row.messageId ?? null,
      messageText: row.messageText ?? null,
      context: Array.isArray(context) ? (context as ReportContextLine[]) : [],
      resolutionNote: row.resolutionNote ?? null,
    };
  }

  private static summary(row: AdminStoredReport): AdminReportRow {
    const { sourceRef: _sourceRef, messageId: _messageId, messageText: _messageText, context: _context, resolutionNote: _note, ...rest } = row;
    return rest;
  }

  async list(query: AdminReportQuery): Promise<AdminReportList> {
    const scope: SQL[] = [];
    if (query.targetUserId) scope.push(eq(playerReports.targetUserId, query.targetUserId));
    if (query.reporterUserId) scope.push(eq(playerReports.reporterUserId, query.reporterUserId));
    const tabFilter = (tab: AdminReportTab): SQL | undefined => (tab === "all" ? undefined : eq(playerReports.status, tab));

    const pattern = query.q ? likeContains(query.q) : null;
    const search = pattern
      ? or(
        like(playerReports.reporterUserId, pattern), like(reporterUser.username, pattern), like(reporterProfile.name, pattern),
        like(playerReports.targetUserId, pattern), like(targetUser.username, pattern), like(targetProfile.name, pattern), like(playerReports.targetName, pattern),
      )
      : undefined;
    const where = and(...scope, tabFilter(query.tab), search);

    const sortColumn = {
      created: playerReports.id,
      category: playerReports.category,
      reporter: reporterUser.username,
      target: targetUser.username,
      status: playerReports.status,
    }[query.sort];
    const order = query.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

    const [rows, totals, ...counters] = await Promise.all([
      this.selectRows().where(where).orderBy(order, desc(playerReports.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize),
      this.database.select({ total: sql<number>`count(*)` }).from(playerReports)
        .leftJoin(reporterUser, eq(reporterUser.id, playerReports.reporterUserId))
        .leftJoin(reporterProfile, eq(reporterProfile.userId, playerReports.reporterUserId))
        .leftJoin(targetUser, eq(targetUser.id, playerReports.targetUserId))
        .leftJoin(targetProfile, eq(targetProfile.userId, playerReports.targetUserId))
        .where(where),
      ...REPORT_TABS.map((tab) =>
        this.database.select({ total: sql<number>`count(*)` }).from(playerReports).where(and(...scope, tabFilter(tab)))),
    ]);

    const counts = Object.fromEntries(REPORT_TABS.map((tab, index) => [tab, Number(counters[index][0]?.total ?? 0)])) as AdminReportList["counts"];
    return {
      total: Number(totals[0]?.total ?? 0),
      counts,
      rows: rows.map((row) => DrizzleAdminReportRepository.summary(this.toRow(row))),
    };
  }

  async countOpen(): Promise<number> {
    const [row] = await this.database.select({ total: sql<number>`count(*)` }).from(playerReports).where(eq(playerReports.status, "open"));
    return Number(row?.total ?? 0);
  }

  async find(id: number): Promise<AdminStoredReport | null> {
    const [row] = await this.selectRows().where(eq(playerReports.id, id)).limit(1);
    return row ? this.toRow(row) : null;
  }

  async relatedTo(targetUserId: string, excludeId: number, limit: number): Promise<AdminReportRow[]> {
    const rows = await this.selectRows()
      .where(and(eq(playerReports.targetUserId, targetUserId), sql`${playerReports.id} <> ${excludeId}`))
      .orderBy(desc(playerReports.id)).limit(Math.max(1, Math.min(100, limit)));
    return rows.map((row) => DrizzleAdminReportRepository.summary(this.toRow(row)));
  }

  async openAgainst(targetUserId: string): Promise<AdminStoredReport[]> {
    const rows = await this.selectRows()
      .where(and(eq(playerReports.targetUserId, targetUserId), eq(playerReports.status, "open")))
      .orderBy(asc(playerReports.id)).limit(500);
    return rows.map((row) => this.toRow(row));
  }

  async claim(ids: number[], outcome: ReportOutcome): Promise<number[]> {
    const claimed: number[] = [];
    for (const id of ids) {
      const result = await this.database.update(playerReports).set({
        status: outcome.status,
        openSlot: null,
        resolutionAction: outcome.action,
        resolutionNote: outcome.note,
        handledAt: outcome.at,
      }).where(and(eq(playerReports.id, id), eq(playerReports.status, "open")));
      if (affectedRows(result) > 0) claimed.push(id);
    }
    return claimed;
  }

  async reopen(ids: number[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.database.update(playerReports).set({
          status: "open", openSlot: 1, resolutionAction: null, resolutionNote: null, handledAt: null,
        }).where(eq(playerReports.id, id));
      } catch {
        // The reporter filed a new open report against the same target meanwhile: this one stays handled.
      }
    }
  }

  async targetState(userId: string, now: Date): Promise<AdminReportDetail["target"] | null> {
    const [row] = await this.database.select({
      userId: users.id, username: users.username, name: userProfile.name, level: userProfile.level,
      isBanned: users.isBanned, banExpiresAt: users.banExpiresAt, chatMutedUntil: users.chatMutedUntil,
    }).from(users).leftJoin(userProfile, eq(userProfile.userId, users.id)).where(eq(users.id, userId)).limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      username: row.username,
      name: row.name ?? row.username,
      level: row.level ?? null,
      banned: row.isBanned === 1 && (!row.banExpiresAt || row.banExpiresAt.getTime() > now.getTime()),
      muted: !!row.chatMutedUntil && row.chatMutedUntil.getTime() > now.getTime(),
    };
  }

  async sanctions(userId: string, limit: number): Promise<AdminReportSanction[]> {
    const rows = await this.database.select().from(auditEvents)
      .where(and(eq(auditEvents.userId, userId), inArray(auditEvents.kind, SANCTION_KINDS)))
      .orderBy(desc(auditEvents.id)).limit(Math.max(1, Math.min(100, limit)));
    return rows.map((row) => ({ id: row.id, kind: row.kind, meta: parseJsonMeta(row.meta), createdAt: row.createdAt.toISOString() }));
  }
}
