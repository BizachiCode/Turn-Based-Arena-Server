import { and, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";

import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { directMessages, dmThreads } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { DmRepository, DmRow, DmThreadRow, NewDm } from "./dm.ports.js";
import { pairKeyOf } from "./social.domain.js";

const messageColumns = {
  id: directMessages.id,
  senderId: directMessages.senderId,
  recipientId: directMessages.recipientId,
  message: directMessages.message,
  originalMessage: directMessages.originalMessage,
  createdAt: directMessages.createdAt,
};

/** Private messages and the per-player conversation list (Drizzle). */
export class DrizzleDmRepository extends DrizzleRepository implements DmRepository {
  constructor(database: Database) {
    super(database);
  }

  async insertMessage(row: NewDm, capPerConversation: number, session: DbSession): Promise<DmRow> {
    const tx = this.db(session);
    const conversationKey = pairKeyOf(row.senderId, row.recipientId);
    const createdAt = new Date();
    createdAt.setMilliseconds(0);
    const [inserted] = await tx.insert(directMessages).values({
      conversationKey,
      senderId: row.senderId,
      recipientId: row.recipientId,
      message: row.message,
      originalMessage: row.original,
      createdAt,
    }).$returningId();
    const id = Number(inserted?.id ?? 0);

    // Sender: the conversation moves up, its own line is read. Recipient: one more unread line. Both thread rows are
    // written in user id order, so two players messaging each other at once lock them in the same order.
    const upserts = [
      { userId: row.senderId, write: () => tx.insert(dmThreads).values({ userId: row.senderId, peerId: row.recipientId, lastMessageId: id, lastAt: createdAt, unread: 0, lastReadId: id })
        .onDuplicateKeyUpdate({ set: { lastMessageId: id, lastAt: createdAt, lastReadId: sql`greatest(${dmThreads.lastReadId}, ${id})` } }) },
      { userId: row.recipientId, write: () => tx.insert(dmThreads).values({ userId: row.recipientId, peerId: row.senderId, lastMessageId: id, lastAt: createdAt, unread: 1, lastReadId: 0 })
        .onDuplicateKeyUpdate({ set: { lastMessageId: id, lastAt: createdAt, unread: sql`${dmThreads.unread} + 1` } }) },
    ].sort((a, b) => (a.userId < b.userId ? -1 : 1));
    for (const upsert of upserts) await upsert.write();

    const [oldestKept] = await tx.select({ id: directMessages.id }).from(directMessages)
      .where(eq(directMessages.conversationKey, conversationKey))
      .orderBy(desc(directMessages.id))
      .limit(1)
      .offset(Math.max(0, capPerConversation - 1));
    if (oldestKept) {
      await tx.delete(directMessages).where(and(eq(directMessages.conversationKey, conversationKey), lt(directMessages.id, oldestKept.id)));
    }
    return { id, senderId: row.senderId, recipientId: row.recipientId, message: row.message, originalMessage: row.original, createdAt };
  }

  async history(userId: string, peerId: string, beforeId: number | null, limit: number): Promise<DmRow[]> {
    const conversation = eq(directMessages.conversationKey, pairKeyOf(userId, peerId));
    const rows = await this.database.select(messageColumns).from(directMessages)
      .where(beforeId ? and(conversation, lt(directMessages.id, beforeId)) : conversation)
      .orderBy(desc(directMessages.id))
      .limit(Math.max(1, limit));
    return rows.reverse();
  }

  async threads(userId: string, limit: number): Promise<DmThreadRow[]> {
    return this.database.select({ peerId: dmThreads.peerId, lastMessageId: dmThreads.lastMessageId, lastAt: dmThreads.lastAt, unread: dmThreads.unread })
      .from(dmThreads).where(eq(dmThreads.userId, userId)).orderBy(desc(dmThreads.lastAt), desc(dmThreads.lastMessageId)).limit(Math.max(1, limit));
  }

  async messagesById(ids: readonly number[]): Promise<DmRow[]> {
    const wanted = [...new Set(ids.filter((id) => id > 0))];
    if (wanted.length === 0) return [];
    return this.database.select(messageColumns).from(directMessages).where(inArray(directMessages.id, wanted));
  }

  async markRead(userId: string, peerId: string, upToId: number): Promise<number> {
    const [thread] = await this.database.select({ lastReadId: dmThreads.lastReadId }).from(dmThreads)
      .where(and(eq(dmThreads.userId, userId), eq(dmThreads.peerId, peerId))).limit(1);
    if (!thread) return 0;
    const lastReadId = Math.max(Number(thread.lastReadId) || 0, upToId);
    const [left] = await this.database.select({ value: count() }).from(directMessages)
      .where(and(eq(directMessages.conversationKey, pairKeyOf(userId, peerId)), eq(directMessages.senderId, peerId), gt(directMessages.id, lastReadId)));
    const unread = Number(left?.value ?? 0);
    await this.database.update(dmThreads).set({ lastReadId, unread })
      .where(and(eq(dmThreads.userId, userId), eq(dmThreads.peerId, peerId)));
    return unread;
  }

  async findMessage(id: number): Promise<DmRow | null> {
    const [row] = await this.database.select(messageColumns).from(directMessages).where(eq(directMessages.id, id)).limit(1);
    return row ?? null;
  }

  async unreadByPeer(userId: string): Promise<Map<string, number>> {
    const rows = await this.database.select({ peerId: dmThreads.peerId, unread: dmThreads.unread }).from(dmThreads)
      .where(and(eq(dmThreads.userId, userId), gt(dmThreads.unread, 0)));
    return new Map(rows.map((row) => [row.peerId, Number(row.unread) || 0]));
  }
}
