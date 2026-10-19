import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { ShopPackPayloadSchema, type ShopPackPayload } from "../../config/ShopCatalog.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { mailBroadcasts, userMail, userMailReceipts, users } from "../../infrastructure/database/schema/index.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { hasRewards } from "../rewards/reward-granter.js";
import { MAIL_CATEGORIES, type MailCategory } from "./mail.domain.js";
import type { MailBroadcastRecord, MailContent, MailCounts, MailRecord, MailRepository } from "./mail.ports.js";

const mailColumns = {
  id: userMail.id,
  userId: userMail.userId,
  category: userMail.category,
  sender: userMail.sender,
  title: userMail.title,
  body: userMail.body,
  titleKey: userMail.titleKey,
  bodyKey: userMail.bodyKey,
  paramsJson: userMail.paramsJson,
  attachmentsJson: userMail.attachmentsJson,
  createdAt: userMail.createdAt,
  expiresAt: userMail.expiresAt,
  readAt: userMail.readAt,
  claimedAt: userMail.claimedAt,
};

type MailRow = { [K in keyof typeof mailColumns]: (typeof mailColumns)[K]["_"]["data"] };

/** Stored strings as `params`; malformed rows read as no params. */
function parseParams(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

/** Stored rewards; malformed or empty bundles read as null (plain message). */
function parseAttachments(value: string | null): ShopPackPayload | null {
  if (!value) return null;
  try {
    const parsed = ShopPackPayloadSchema.safeParse(JSON.parse(value));
    return parsed.success && hasRewards(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

function toCategory(value: string): MailCategory {
  return (MAIL_CATEGORIES as readonly string[]).includes(value) ? (value as MailCategory) : "system";
}

function contentOf(row: Omit<MailRow, "id" | "userId" | "createdAt" | "readAt" | "claimedAt">): MailContent {
  return {
    category: toCategory(row.category),
    sender: row.sender,
    title: row.title,
    body: row.body ?? "",
    titleKey: row.titleKey,
    bodyKey: row.bodyKey,
    params: parseParams(row.paramsJson),
    attachments: parseAttachments(row.attachmentsJson),
    expiresAt: row.expiresAt,
  };
}

function toRecord(row: MailRow): MailRecord {
  return { ...contentOf(row), id: row.id, userId: row.userId, createdAt: row.createdAt, readAt: row.readAt, claimedAt: row.claimedAt };
}

function contentColumns(content: MailContent) {
  return {
    category: content.category,
    sender: content.sender,
    title: content.title,
    body: content.body,
    titleKey: content.titleKey,
    bodyKey: content.bodyKey,
    paramsJson: content.params.length > 0 ? JSON.stringify(content.params) : null,
    attachmentsJson: content.attachments ? JSON.stringify(content.attachments) : null,
    expiresAt: content.expiresAt,
  };
}

/** Not expired at `now`. */
const activeAt = (now: Date) => or(isNull(userMail.expiresAt), gt(userMail.expiresAt, now));

/** Unclaimed mail with rewards (a stored bundle always grants something, see `parseAttachments`). */
const pendingRewards = and(isNotNull(userMail.attachmentsJson), isNull(userMail.claimedAt));

export class DrizzleMailRepository extends DrizzleRepository implements MailRepository {
  constructor(database: Database) {
    super(database);
  }

  async listInbox(userId: string, now: Date, limit: number): Promise<MailRecord[]> {
    const rows = await this.database.select(mailColumns).from(userMail)
      .where(and(eq(userMail.userId, userId), activeAt(now)))
      .orderBy(desc(userMail.createdAt), desc(userMail.id))
      .limit(Math.min(limit, 1000));
    return rows.map(toRecord);
  }

  async counts(userId: string, now: Date): Promise<MailCounts> {
    const [row] = await this.database.select({
      unread: sql<number>`coalesce(sum(case when ${userMail.readAt} is null then 1 else 0 end), 0)`,
      claimable: sql<number>`coalesce(sum(case when ${userMail.attachmentsJson} is not null and ${userMail.claimedAt} is null then 1 else 0 end), 0)`,
    }).from(userMail).where(and(eq(userMail.userId, userId), activeAt(now)));
    return { unread: Number(row?.unread ?? 0), claimable: Number(row?.claimable ?? 0) };
  }

  async find(userId: string, mailId: string, session: DbSession, forUpdate = false): Promise<MailRecord | null> {
    const query = this.db(session).select(mailColumns).from(userMail)
      .where(and(eq(userMail.userId, userId), eq(userMail.id, mailId))).limit(1);
    const [row] = await (forUpdate ? query.for("update") : query);
    return row ? toRecord(row) : null;
  }

  async listClaimable(userId: string, now: Date, session: DbSession): Promise<MailRecord[]> {
    const rows = await this.db(session).select(mailColumns).from(userMail)
      .where(and(eq(userMail.userId, userId), activeAt(now), pendingRewards))
      .orderBy(asc(userMail.createdAt), asc(userMail.id));
    return rows.map(toRecord).filter((mail) => !!mail.attachments);
  }

  async insert(mail: Omit<MailRecord, "readAt" | "claimedAt" | "createdAt"> & { createdAt?: Date }, session: DbSession): Promise<void> {
    await this.db(session).insert(userMail).values({
      id: mail.id,
      userId: mail.userId,
      ...contentColumns(mail),
      ...(mail.createdAt ? { createdAt: mail.createdAt } : {}),
    });
  }

  async markRead(userId: string, mailIds: string[], at: Date, session?: DbSession): Promise<void> {
    if (mailIds.length === 0) return;
    await this.db(session).update(userMail).set({ readAt: at })
      .where(and(eq(userMail.userId, userId), inArray(userMail.id, mailIds), isNull(userMail.readAt)));
  }

  async markClaimed(userId: string, mailId: string, at: Date, session: DbSession): Promise<void> {
    await this.db(session).update(userMail).set({ claimedAt: at })
      .where(and(eq(userMail.userId, userId), eq(userMail.id, mailId)));
  }

  async delete(userId: string, mailIds: string[], session: DbSession): Promise<number> {
    if (mailIds.length === 0) return 0;
    const result = await this.db(session).delete(userMail).where(and(eq(userMail.userId, userId), inArray(userMail.id, mailIds)));
    return affectedRows(result);
  }

  async deleteExpired(userId: string, before: Date, session?: DbSession): Promise<void> {
    await this.db(session).delete(userMail)
      .where(and(eq(userMail.userId, userId), isNotNull(userMail.expiresAt), lte(userMail.expiresAt, before)));
  }

  async trim(userId: string, limit: number, now: Date, session: DbSession): Promise<void> {
    const db = this.db(session);
    const rows = await db.select({ id: userMail.id, readAt: userMail.readAt, claimedAt: userMail.claimedAt, attachmentsJson: userMail.attachmentsJson, expiresAt: userMail.expiresAt })
      .from(userMail).where(eq(userMail.userId, userId))
      .orderBy(desc(userMail.createdAt), desc(userMail.id));
    if (rows.length <= limit) return;

    const removable = rows.slice(limit).filter((row) => {
      const expired = !!row.expiresAt && row.expiresAt.getTime() <= now.getTime();
      const pending = !!row.attachmentsJson && !row.claimedAt;
      return expired || (!!row.readAt && !pending);
    }).map((row) => row.id);
    if (removable.length > 0) await db.delete(userMail).where(and(eq(userMail.userId, userId), inArray(userMail.id, removable)));
  }

  async insertReceipt(userId: string, receiptKey: string, session: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(userMailReceipts).values({ userId, receiptKey });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async insertBroadcast(broadcast: Omit<MailBroadcastRecord, "createdAt">, session?: DbSession): Promise<void> {
    await this.db(session).insert(mailBroadcasts).values({
      id: broadcast.id,
      ...contentColumns(broadcast),
      includeNewPlayers: broadcast.includeNewPlayers ? 1 : 0,
    });
  }

  async listActiveBroadcasts(now: Date): Promise<MailBroadcastRecord[]> {
    const rows = await this.database.select().from(mailBroadcasts)
      .where(or(isNull(mailBroadcasts.expiresAt), gt(mailBroadcasts.expiresAt, now)))
      .orderBy(asc(mailBroadcasts.createdAt), asc(mailBroadcasts.id))
      .limit(200);
    return rows.map((row) => ({
      ...contentOf(row),
      id: row.id,
      includeNewPlayers: row.includeNewPlayers === 1,
      createdAt: row.createdAt,
    }));
  }

  async receiptsOf(userId: string, keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.database.select({ key: userMailReceipts.receiptKey }).from(userMailReceipts)
      .where(and(eq(userMailReceipts.userId, userId), inArray(userMailReceipts.receiptKey, keys)));
    return new Set(rows.map((row) => row.key));
  }

  async accountCreatedAt(userId: string): Promise<Date | null> {
    const [row] = await this.database.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.createdAt ?? null;
  }
}
