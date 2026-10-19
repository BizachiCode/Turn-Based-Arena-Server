// Mailbox use cases: inbox, read, claim (one / all), delete, and the senders used by other modules (guild notices,
// guild quests...), the GM panel (single player or broadcast) and the welcome mail of `mail.json`.
//
// Rewards are granted with the shared RewardGranter inside the claim transaction, under the mail's row lock, so a
// mail is claimed at most once. Deliveries with a receipt key (welcome mail, broadcasts, one-off notices) are
// idempotent: `user_mail_receipts` keeps the key even after the player deletes the mail.

import { randomBytes } from "node:crypto";

import type { MailConfig, MailTemplate } from "../../config/MailCatalog.js";
import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import { emptyGrants, hasRewards, mergeGrants, type RewardGranter } from "../rewards/reward-granter.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";
import { canDelete, cleanMailParam, cleanMailText, expiryAfter, hasPendingRewards, isExpired, MAIL_LIMITS, type MailCategory } from "./mail.domain.js";
import type { MailClaimDto, MailDto, MailInboxDto, MailSummaryDto } from "./mail.dto.js";
import type { MailContent, MailNotifier, MailRecord, MailRepository } from "./mail.ports.js";

const logger = createLogger("MailService");

/** What a sender provides; missing fields get defaults (category "system", default expiration of `mail.json`). */
export type MailDraft = {
  category?: MailCategory;
  sender?: string | null;
  title?: string | null;
  body?: string | null;
  titleKey?: string | null;
  bodyKey?: string | null;
  params?: Array<string | number>;
  attachments?: ShopPackPayload | null;
  /** Explicit expiration (null = never). Wins over `expirationDays`. */
  expiresAt?: Date | null;
  /** Days until it expires (0 = never). Defaults to `mail.json` `defaultExpirationDays`. */
  expirationDays?: number;
};

export type MailSendOptions = {
  /** Idempotency key: a second send with the same key to the same player is skipped. */
  receiptKey?: string;
};

export type MailServiceDeps = {
  mail: MailRepository;
  rewards: RewardGranter;
  ledger: WalletLedger;
  rosterCache: RosterCache;
  runeCache: RuneCache;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
  config: () => MailConfig;
  notifier?: MailNotifier | null;
  /** Id factory (tests inject deterministic ones). */
  newMailId?: () => string;
};

const WELCOME_RECEIPT = "welcome";
const broadcastReceipt = (broadcastId: string) => `broadcast:${broadcastId}`;
const iso = (date: Date | null) => (date ? date.toISOString() : null);

export class MailService {
  private readonly newMailId: () => string;

  constructor(private readonly deps: MailServiceDeps) {
    this.newMailId = deps.newMailId ?? (() => randomBytes(8).toString("hex"));
  }

  private get repo(): MailRepository {
    return this.deps.mail;
  }

  private get cfg(): MailConfig {
    return this.deps.config();
  }

  // ── Player requests ───────────────────────────────────────────────────

  /** The inbox (delivers the welcome mail and pending broadcasts first, drops expired mails). */
  async getInbox(userId: string): Promise<MailInboxDto> {
    await this.deliverPending(userId);
    await this.repo.deleteExpired(userId, this.deps.clock.now());
    return this.inbox(userId);
  }

  /** Unread / claimable counts for the menu badge. */
  async summary(userId: string): Promise<MailSummaryDto> {
    await this.deliverPending(userId);
    const counts = await this.repo.counts(userId, this.deps.clock.now());
    return { ok: true, ...counts };
  }

  /** Marks mails as read (unknown ids are ignored). */
  async read(userId: string, mailIds: string[]): Promise<MailInboxDto> {
    if (mailIds.length > 0) await this.repo.markRead(userId, mailIds, this.deps.clock.now());
    return this.inbox(userId);
  }

  /** Claims the rewards of one mail (also marks it read). */
  async claim(userId: string, mailId: string): Promise<MailClaimDto> {
    const grants = await this.claimOne(userId, mailId);
    await this.invalidateCaches(userId, grants);
    return {
      ...(await this.inbox(userId)),
      claimedIds: [mailId],
      grants,
      wallet: await this.deps.ledger.snapshot(userId),
      stoppedBy: null,
    };
  }

  /**
   * Claims every mail with rewards, oldest first, one transaction per mail. When a claim fails (e.g. full rune
   * inventory) the remaining mails stay unclaimed and `stoppedBy` names the error; failing on the first mail throws.
   */
  async claimAll(userId: string): Promise<MailClaimDto> {
    const pending = await this.deps.uow.transaction((session) => this.repo.listClaimable(userId, this.deps.clock.now(), session));
    if (pending.length === 0) throw new AppError(ErrorCode.MAIL_NOTHING_TO_CLAIM);

    const total = emptyGrants();
    const claimedIds: string[] = [];
    let stoppedBy: string | null = null;
    for (const mail of pending) {
      try {
        mergeGrants(total, await this.claimOne(userId, mail.id));
        claimedIds.push(mail.id);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // Claimed/expired meanwhile (another device): skip it.
        if (error.errorCode === ErrorCode.MAIL_ALREADY_CLAIMED || error.errorCode === ErrorCode.MAIL_EXPIRED
          || error.errorCode === ErrorCode.MAIL_NOT_FOUND) continue;
        if (claimedIds.length === 0) throw error;
        stoppedBy = error.errorCode;
        break;
      }
    }
    if (claimedIds.length === 0) throw new AppError(ErrorCode.MAIL_NOTHING_TO_CLAIM);

    await this.invalidateCaches(userId, total);
    return {
      ...(await this.inbox(userId)),
      claimedIds,
      grants: total,
      wallet: await this.deps.ledger.snapshot(userId),
      stoppedBy,
    };
  }

  /** Deletes mails. A single mail with unclaimed rewards answers MAIL_HAS_REWARDS; in a batch such mails are kept. */
  async delete(userId: string, mailIds: string[]): Promise<MailInboxDto> {
    const now = this.deps.clock.now();
    await this.deps.uow.transaction(async (session) => {
      const deletable: string[] = [];
      for (const mailId of new Set(mailIds)) {
        const mail = await this.repo.find(userId, mailId, session, true);
        if (!mail) {
          if (mailIds.length === 1) throw new AppError(ErrorCode.MAIL_NOT_FOUND);
          continue;
        }
        if (!canDelete(mail, now)) {
          if (mailIds.length === 1) throw new AppError(ErrorCode.MAIL_HAS_REWARDS);
          continue;
        }
        deletable.push(mail.id);
      }
      if (deletable.length > 0) await this.repo.delete(userId, deletable, session);
    });
    return this.inbox(userId);
  }

  /** Deletes every read mail that has no unclaimed rewards. */
  async deleteRead(userId: string): Promise<MailInboxDto> {
    const now = this.deps.clock.now();
    const ids = (await this.repo.listInbox(userId, now, Number.MAX_SAFE_INTEGER))
      .filter((mail) => mail.readAt && canDelete(mail, now))
      .map((mail) => mail.id);
    if (ids.length > 0) return this.delete(userId, ids);
    return this.inbox(userId);
  }

  // ── Senders ───────────────────────────────────────────────────────────

  /**
   * Sends a mail in its own transaction and pushes the "new mail" notice. Returns false when `receiptKey` was already
   * delivered to this player.
   */
  async send(userId: string, draft: MailDraft, options: MailSendOptions = {}): Promise<boolean> {
    const content = this.normalize(draft);
    const sent = await this.deps.uow.transaction((session) => this.insert(session, userId, content, options));
    if (sent) await this.notify([userId]);
    return sent;
  }

  /**
   * Sends a mail inside the caller's transaction (e.g. a guild notice committed with the membership change). The caller
   * pushes the notice after the commit with {@link notify}.
   */
  async sendInSession(session: DbSession, userId: string, draft: MailDraft, options: MailSendOptions = {}): Promise<boolean> {
    return this.insert(session, userId, this.normalize(draft), options);
  }

  /** Pushes the "new mail" notice to connected players (best effort). */
  async notify(userIds: string[]): Promise<void> {
    const notifier = this.deps.notifier;
    if (!notifier) return;
    for (const userId of new Set(userIds)) {
      try {
        await notifier.mailChanged(userId);
      } catch (error) {
        logger.warn("mail push failed:", (error as Error).message);
      }
    }
  }

  /**
   * Mail for every player: stored once and copied into each inbox when the player next opens it (or asks the badge
   * counts). `includeNewPlayers` also delivers it to accounts created later, until it expires.
   */
  async broadcast(draft: MailDraft, includeNewPlayers = false): Promise<{ broadcastId: string }> {
    const content = this.normalize({ category: "gm", ...draft });
    const broadcastId = this.newMailId();
    await this.deps.uow.transaction(async (session) => {
      await this.repo.insertBroadcast({ ...content, id: broadcastId, includeNewPlayers }, session);
      await this.deps.audit.record({ userId: null, kind: "MAIL_BROADCAST", meta: { broadcastId, title: content.title, rewards: hasRewards(content.attachments) } }, session);
    });
    try {
      await this.deps.notifier?.mailBroadcast();
    } catch (error) {
      logger.warn("mail broadcast push failed:", (error as Error).message);
    }
    return { broadcastId };
  }

  /** Throws INVALID_PAYLOAD when a reward of the bundle cannot be granted by this server (unknown currency...). */
  validateAttachments(attachments: ShopPackPayload | null | undefined): void {
    if (!attachments) return;
    const unsupported = this.deps.rewards.unsupported(attachments);
    if (unsupported.length > 0) throw new AppError(ErrorCode.INVALID_PAYLOAD, { extra: { rewards: unsupported } });
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async claimOne(userId: string, mailId: string): Promise<ShopGrantsDto> {
    const now = this.deps.clock.now();
    return this.deps.uow.transaction(async (session) => {
      const mail = await this.repo.find(userId, mailId, session, true);
      if (!mail) throw new AppError(ErrorCode.MAIL_NOT_FOUND);
      if (isExpired(mail, now)) throw new AppError(ErrorCode.MAIL_EXPIRED);
      if (mail.claimedAt) throw new AppError(ErrorCode.MAIL_ALREADY_CLAIMED);
      if (!hasRewards(mail.attachments)) throw new AppError(ErrorCode.MAIL_NOTHING_TO_CLAIM);

      const grants = await this.deps.rewards.grant(session, userId, mail.attachments, { runeOrigin: "mail" });
      await this.repo.markClaimed(userId, mail.id, now, session);
      await this.repo.markRead(userId, [mail.id], now, session);
      await this.deps.audit.record({
        userId,
        kind: "MAIL_CLAIM",
        meta: { mailId: mail.id, category: mail.category, currencies: grants.currencies, characters: grants.characters.length, runes: grants.runes.length },
      }, session);
      return grants;
    });
  }

  private async insert(session: DbSession, userId: string, content: MailContent, options: MailSendOptions): Promise<boolean> {
    if (options.receiptKey && !(await this.repo.insertReceipt(userId, options.receiptKey, session))) return false;
    await this.repo.insert({ ...content, id: this.newMailId(), userId, createdAt: this.deps.clock.now() }, session);
    await this.repo.trim(userId, this.cfg.inboxLimit, this.deps.clock.now(), session);
    return true;
  }

  /** Delivers the welcome mail and the broadcasts the player has not received yet. */
  private async deliverPending(userId: string): Promise<void> {
    const now = this.deps.clock.now();
    const welcome = this.cfg.welcome;
    const broadcasts = await this.repo.listActiveBroadcasts(now);
    const keys = [...(welcome.enabled ? [WELCOME_RECEIPT] : []), ...broadcasts.map((broadcast) => broadcastReceipt(broadcast.id))];
    if (keys.length === 0) return;

    const received = await this.repo.receiptsOf(userId, keys);
    const missing = broadcasts.filter((broadcast) => !received.has(broadcastReceipt(broadcast.id)));
    const needsWelcome = welcome.enabled && !received.has(WELCOME_RECEIPT);
    if (!needsWelcome && missing.length === 0) return;

    const createdAt = missing.some((broadcast) => !broadcast.includeNewPlayers) ? await this.repo.accountCreatedAt(userId) : null;
    await this.deps.uow.transaction(async (session) => {
      if (needsWelcome) await this.insert(session, userId, this.fromTemplate(welcome), { receiptKey: WELCOME_RECEIPT });
      for (const broadcast of missing) {
        // Accounts created after a broadcast that excludes new players never receive it.
        if (!broadcast.includeNewPlayers && createdAt && createdAt.getTime() > broadcast.createdAt.getTime()) continue;
        const { id: _id, includeNewPlayers: _include, createdAt: _created, ...content } = broadcast;
        await this.insert(session, userId, content, { receiptKey: broadcastReceipt(broadcast.id) });
      }
    });
  }

  private fromTemplate(template: MailTemplate): MailContent {
    return this.normalize({
      category: "reward",
      sender: template.sender,
      title: template.title,
      body: template.body,
      titleKey: template.titleKey,
      bodyKey: template.bodyKey,
      attachments: hasRewards(template.attachments) ? template.attachments : null,
      expirationDays: template.expirationDays,
    });
  }

  private normalize(draft: MailDraft): MailContent {
    const now = this.deps.clock.now();
    const key = (value: string | null | undefined) => {
      const text = cleanMailText(value, MAIL_LIMITS.key);
      return text.length > 0 ? text : null;
    };
    const expiresAt = draft.expiresAt !== undefined
      ? draft.expiresAt
      : expiryAfter(now, draft.expirationDays ?? this.cfg.defaultExpirationDays);
    return {
      category: draft.category ?? "system",
      sender: cleanMailText(draft.sender, MAIL_LIMITS.sender),
      title: cleanMailText(draft.title, MAIL_LIMITS.title),
      body: cleanMailText(draft.body, MAIL_LIMITS.body),
      titleKey: key(draft.titleKey),
      bodyKey: key(draft.bodyKey),
      params: (draft.params ?? []).slice(0, MAIL_LIMITS.params).map((param) => cleanMailParam(String(param))),
      attachments: hasRewards(draft.attachments) ? draft.attachments : null,
      expiresAt,
    };
  }

  private async inbox(userId: string): Promise<MailInboxDto> {
    const now = this.deps.clock.now();
    const limit = this.cfg.inboxLimit;
    const mails = await this.repo.listInbox(userId, now, limit);
    return {
      ok: true,
      serverTime: now.toISOString(),
      mails: mails.map((mail) => this.toDto(mail)),
      unread: mails.filter((mail) => !mail.readAt).length,
      claimable: mails.filter((mail) => hasPendingRewards(mail)).length,
      inboxLimit: limit,
    };
  }

  private toDto(mail: MailRecord): MailDto {
    return {
      mailId: mail.id,
      category: mail.category,
      sender: mail.sender,
      title: mail.title,
      body: mail.body,
      titleKey: mail.titleKey,
      bodyKey: mail.bodyKey,
      params: mail.params,
      attachments: mail.attachments,
      createdAt: mail.createdAt.toISOString(),
      expiresAt: iso(mail.expiresAt),
      read: !!mail.readAt,
      claimed: !!mail.claimedAt,
    };
  }

  private async invalidateCaches(userId: string, grants: ShopGrantsDto): Promise<void> {
    if (grants.characters.length > 0) await this.deps.rosterCache.invalidate(userId);
    if (grants.runes.length > 0) await this.deps.runeCache.invalidate(userId);
  }
}
