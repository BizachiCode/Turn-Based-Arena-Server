import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { MailCategory } from "./mail.domain.js";

/** Content of a mail (what senders provide). Literal texts are the fallback of the translation keys. */
export type MailContent = {
  category: MailCategory;
  sender: string;
  title: string;
  body: string;
  titleKey: string | null;
  bodyKey: string | null;
  /** Values for `{0}`, `{1}`... in the translated texts. */
  params: string[];
  /** Rewards granted when claimed (null = plain message). */
  attachments: ShopPackPayload | null;
  /** null = never expires. */
  expiresAt: Date | null;
};

/** One mail of a player (`user_mail`). */
export type MailRecord = MailContent & {
  id: string;
  userId: string;
  createdAt: Date;
  readAt: Date | null;
  claimedAt: Date | null;
};

/** A mail sent to every player (`mail_broadcasts`). */
export type MailBroadcastRecord = MailContent & {
  id: string;
  includeNewPlayers: boolean;
  createdAt: Date;
};

export type MailCounts = { unread: number; claimable: number };

/** Persistence port of the mailbox. Every query is scoped by the owner's user id. */
export interface MailRepository {
  /** Newest-first mails that have not expired at `now`. */
  listInbox(userId: string, now: Date, limit: number): Promise<MailRecord[]>;
  counts(userId: string, now: Date): Promise<MailCounts>;
  find(userId: string, mailId: string, session: DbSession, forUpdate?: boolean): Promise<MailRecord | null>;
  /** Unexpired mails with unclaimed rewards, oldest first (locked). */
  listClaimable(userId: string, now: Date, session: DbSession): Promise<MailRecord[]>;
  insert(mail: Omit<MailRecord, "readAt" | "claimedAt" | "createdAt"> & { createdAt?: Date }, session: DbSession): Promise<void>;
  markRead(userId: string, mailIds: string[], at: Date, session?: DbSession): Promise<void>;
  markClaimed(userId: string, mailId: string, at: Date, session: DbSession): Promise<void>;
  /** Deletes the given mails; returns how many were removed. */
  delete(userId: string, mailIds: string[], session: DbSession): Promise<number>;
  /** Removes mails that expired before `before`. */
  deleteExpired(userId: string, before: Date, session?: DbSession): Promise<void>;
  /**
   * Keeps the inbox within `limit`: deletes the oldest read mails without unclaimed rewards (or expired) beyond it.
   * Mails with pending rewards are never removed here.
   */
  trim(userId: string, limit: number, now: Date, session: DbSession): Promise<void>;

  /** Records a delivery key; false when it was already recorded (the send is skipped). */
  insertReceipt(userId: string, receiptKey: string, session: DbSession): Promise<boolean>;

  insertBroadcast(broadcast: Omit<MailBroadcastRecord, "createdAt">, session?: DbSession): Promise<void>;
  /** Broadcasts that have not expired at `now`, oldest first. */
  listActiveBroadcasts(now: Date): Promise<MailBroadcastRecord[]>;
  /** Receipt keys of the player among `keys`. */
  receiptsOf(userId: string, keys: string[]): Promise<Set<string>>;
  /** Account creation date (broadcasts that exclude new players). */
  accountCreatedAt(userId: string): Promise<Date | null>;
}

/** Live "you have mail" push (presence room `mail_new`; the client then asks `mail/summary`). Optional. */
export interface MailNotifier {
  /** New mail for one player. */
  mailChanged(userId: string): Promise<void>;
  /** New broadcast for every connected player. */
  mailBroadcast(): Promise<void>;
}
