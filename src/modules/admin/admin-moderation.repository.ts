import { and, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { auditEvents, chatMessages, guildChatMessages, guilds, mailBroadcasts, userMailReceipts, users } from "../../infrastructure/database/schema/index.js";
import { parseJsonMeta } from "./admin.repository.js";
import type {
  AdminAuditQuery,
  AdminAuditRow,
  AdminChatMessage,
  AdminChatQuery,
  AdminChatScope,
  AdminDirectMail,
  AdminMailBroadcast,
  AdminModerationRepository,
} from "./admin-moderation.ports.js";

const MAX_KINDS = 200;

export class DrizzleAdminModerationRepository extends DrizzleRepository implements AdminModerationRepository {
  constructor(database: Database) {
    super(database);
  }

  async chatMessages(query: AdminChatQuery): Promise<AdminChatMessage[]> {
    const db = this.database;
    const limit = Math.max(1, Math.min(200, query.limit));

    if (query.scope === "global") {
      const conditions: SQL[] = [];
      if (query.channel !== null) conditions.push(eq(chatMessages.channel, query.channel));
      if (query.userId) conditions.push(eq(chatMessages.userId, query.userId));
      if (query.before) conditions.push(lt(chatMessages.id, query.before));
      const rows = await db.select().from(chatMessages).where(and(...conditions)).orderBy(desc(chatMessages.id)).limit(limit);
      return rows.map((row) => ({
        id: row.id, scope: "global" as const, channel: row.channel, guildId: null as string | null, guildName: null as string | null, userId: row.userId as string | null,
        nickname: row.nickname, level: row.level, message: row.message, original: row.originalMessage, system: false, createdAt: row.createdAt.toISOString(),
      }));
    }

    const conditions: SQL[] = [];
    if (query.guildId) conditions.push(eq(guildChatMessages.guildId, query.guildId));
    if (query.userId) conditions.push(eq(guildChatMessages.userId, query.userId));
    if (query.before) conditions.push(lt(guildChatMessages.id, query.before));
    const rows = await db.select({
      id: guildChatMessages.id, guildId: guildChatMessages.guildId, guildName: guilds.name, userId: guildChatMessages.userId,
      kind: guildChatMessages.kind, nickname: guildChatMessages.nickname, level: guildChatMessages.level,
      message: guildChatMessages.message, original: guildChatMessages.originalMessage, createdAt: guildChatMessages.createdAt,
    }).from(guildChatMessages).innerJoin(guilds, eq(guilds.id, guildChatMessages.guildId))
      .where(and(...conditions)).orderBy(desc(guildChatMessages.id)).limit(limit);
    return rows.map((row) => ({
      id: row.id, scope: "guild" as const, channel: null as number | null, guildId: row.guildId, guildName: row.guildName, userId: row.userId,
      nickname: row.nickname, level: row.level, message: row.message, original: row.original, system: row.kind === "system", createdAt: row.createdAt.toISOString(),
    }));
  }

  async chatChannels() {
    const rows = await this.database.select({
      channel: chatMessages.channel,
      messages: sql<number>`count(*)`,
      lastAt: sql<Date>`max(${chatMessages.createdAt})`.mapWith(chatMessages.createdAt), // parsed as UTC
    }).from(chatMessages).groupBy(chatMessages.channel).orderBy(chatMessages.channel).limit(200);
    return rows.map((row) => ({ channel: row.channel, messages: Number(row.messages), lastAt: new Date(row.lastAt).toISOString() }));
  }

  async deleteChatMessage(scope: AdminChatScope, id: number): Promise<AdminChatMessage | null> {
    const [found] = await this.chatMessages({ scope, channel: null, guildId: null, userId: null, limit: 1, before: id + 1 });
    if (!found || found.id !== id) return null;
    if (scope === "global") await this.database.delete(chatMessages).where(eq(chatMessages.id, id));
    else await this.database.delete(guildChatMessages).where(eq(guildChatMessages.id, id));
    return found;
  }

  async broadcasts(limit: number, now: Date): Promise<AdminMailBroadcast[]> {
    const rows = await this.database.select({
      id: mailBroadcasts.id, title: mailBroadcasts.title, sender: mailBroadcasts.sender, attachments: mailBroadcasts.attachmentsJson,
      includeNewPlayers: mailBroadcasts.includeNewPlayers, createdAt: mailBroadcasts.createdAt, expiresAt: mailBroadcasts.expiresAt,
      recipients: sql<number>`(select count(*) from ${userMailReceipts} where ${userMailReceipts.receiptKey} = concat('broadcast:', ${mailBroadcasts.id}))`,
    }).from(mailBroadcasts).orderBy(desc(mailBroadcasts.createdAt), desc(mailBroadcasts.id)).limit(Math.max(1, Math.min(200, limit)));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      sender: row.sender,
      hasRewards: !!row.attachments && row.attachments !== "null" && row.attachments !== "{}",
      includeNewPlayers: row.includeNewPlayers === 1,
      recipients: Number(row.recipients ?? 0),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      active: !row.expiresAt || row.expiresAt.getTime() > now.getTime(),
    }));
  }

  async directMails(limit: number, before: number | null): Promise<AdminDirectMail[]> {
    const conditions: SQL[] = [eq(auditEvents.kind, "GM_MAIL")];
    if (before) conditions.push(lt(auditEvents.id, before));
    const rows = await this.database.select({
      id: auditEvents.id, userId: auditEvents.userId, username: users.username, meta: auditEvents.meta, createdAt: auditEvents.createdAt,
    }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.userId))
      .where(and(...conditions)).orderBy(desc(auditEvents.id)).limit(Math.max(1, Math.min(200, limit)));
    return rows.map((row) => {
      const meta = (parseJsonMeta(row.meta) ?? {}) as { title?: unknown; reason?: unknown };
      return {
        auditId: row.id,
        userId: row.userId,
        username: row.username ?? null,
        title: typeof meta.title === "string" ? meta.title : "",
        reason: typeof meta.reason === "string" ? meta.reason : null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async revokeBroadcast(id: string): Promise<{ title: string } | null> {
    const [row] = await this.database.select({ title: mailBroadcasts.title }).from(mailBroadcasts).where(eq(mailBroadcasts.id, id)).limit(1);
    if (!row) return null;
    await this.database.delete(mailBroadcasts).where(eq(mailBroadcasts.id, id));
    return row;
  }

  async auditLog(query: AdminAuditQuery): Promise<AdminAuditRow[]> {
    const conditions: SQL[] = [];
    if (query.kind) conditions.push(eq(auditEvents.kind, query.kind));
    if (query.userId) conditions.push(eq(auditEvents.userId, query.userId));
    if (query.from) conditions.push(gte(auditEvents.createdAt, query.from));
    if (query.to) conditions.push(lte(auditEvents.createdAt, query.to));
    if (query.before) conditions.push(lt(auditEvents.id, query.before));
    const rows = await this.database.select({
      id: auditEvents.id, kind: auditEvents.kind, userId: auditEvents.userId, username: users.username,
      meta: auditEvents.meta, createdAt: auditEvents.createdAt,
    }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.userId))
      .where(and(...conditions)).orderBy(desc(auditEvents.id)).limit(Math.max(1, Math.min(200, query.limit)));
    return rows.map((row) => ({
      id: row.id, kind: row.kind, userId: row.userId, username: row.username ?? null, meta: parseJsonMeta(row.meta), createdAt: row.createdAt.toISOString(),
    }));
  }

  async auditKinds(): Promise<string[]> {
    const rows = await this.database.select({ kind: auditEvents.kind }).from(auditEvents).groupBy(auditEvents.kind).orderBy(auditEvents.kind).limit(MAX_KINDS);
    return rows.map((row) => row.kind);
  }
}
