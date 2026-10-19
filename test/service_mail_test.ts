import assert from "node:assert/strict";

import { MailConfigSchema, type MailConfig } from "../src/config/MailCatalog";
import { emptyPayload, type ShopPackPayload } from "../src/config/ShopCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { noAudit } from "../src/shared/kernel/audit";
import { noCache } from "../src/shared/kernel/cache";
import { FixedClock } from "../src/shared/kernel/clock";
import { canDelete, cleanMailParam, cleanMailText, expiryAfter } from "../src/modules/mail/mail.domain";
import type { MailBroadcastRecord, MailCounts, MailRecord, MailRepository } from "../src/modules/mail/mail.ports";
import { MailService } from "../src/modules/mail/mail.service";
import { RosterCache } from "../src/modules/roster/roster.cache";
import { RuneCache } from "../src/modules/rune/rune.cache";
import { InMemoryUnitOfWork } from "./support/fakes";
import { rewardKit } from "./support/reward-kit";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const DAY = 86_400_000;
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.errorCode === code;

const gems = (amount: number): ShopPackPayload => ({ ...emptyPayload(), currencies: [{ currencyId: "DM", amount }] });

/** In-memory mailbox (same semantics as the Drizzle repository). */
class InMemoryMailRepository implements MailRepository {
  mails: MailRecord[] = [];
  receipts = new Set<string>();
  broadcasts: MailBroadcastRecord[] = [];
  accounts = new Map<string, Date>();

  snapshot(): unknown { return { mails: structuredClone(this.mails), receipts: new Set(this.receipts) }; }
  restore(state: unknown): void {
    const value = state as { mails: MailRecord[]; receipts: Set<string> };
    this.mails = value.mails;
    this.receipts = value.receipts;
  }

  private active(userId: string, now: Date) {
    return this.mails.filter((mail) => mail.userId === userId && (!mail.expiresAt || mail.expiresAt > now));
  }

  async listInbox(userId: string, now: Date, limit: number) {
    return this.active(userId, now).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit).map((mail) => structuredClone(mail));
  }
  async counts(userId: string, now: Date): Promise<MailCounts> {
    const mails = this.active(userId, now);
    return { unread: mails.filter((mail) => !mail.readAt).length, claimable: mails.filter((mail) => mail.attachments && !mail.claimedAt).length };
  }
  async find(userId: string, mailId: string) {
    const mail = this.mails.find((entry) => entry.userId === userId && entry.id === mailId);
    return mail ? structuredClone(mail) : null;
  }
  async listClaimable(userId: string, now: Date) {
    return this.active(userId, now).filter((mail) => mail.attachments && !mail.claimedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((mail) => structuredClone(mail));
  }
  async insert(mail: Omit<MailRecord, "readAt" | "claimedAt" | "createdAt"> & { createdAt?: Date }) {
    this.mails.push({ ...structuredClone(mail), createdAt: mail.createdAt ?? new Date(NOW), readAt: null, claimedAt: null });
  }
  async markRead(userId: string, mailIds: string[], at: Date) {
    for (const mail of this.mails) if (mail.userId === userId && mailIds.includes(mail.id) && !mail.readAt) mail.readAt = at;
  }
  async markClaimed(userId: string, mailId: string, at: Date) {
    const mail = this.mails.find((entry) => entry.userId === userId && entry.id === mailId);
    if (mail) mail.claimedAt = at;
  }
  async delete(userId: string, mailIds: string[]) {
    const before = this.mails.length;
    this.mails = this.mails.filter((mail) => !(mail.userId === userId && mailIds.includes(mail.id)));
    return before - this.mails.length;
  }
  async deleteExpired(userId: string, before: Date) {
    this.mails = this.mails.filter((mail) => !(mail.userId === userId && mail.expiresAt && mail.expiresAt <= before));
  }
  async trim(userId: string, limit: number, now: Date) {
    const mine = this.mails.filter((mail) => mail.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const removable = new Set(mine.slice(limit).filter((mail) => canDelete(mail, now) && (!!mail.readAt || (!!mail.expiresAt && mail.expiresAt <= now))).map((mail) => mail.id));
    this.mails = this.mails.filter((mail) => !removable.has(mail.id));
  }
  async insertReceipt(userId: string, receiptKey: string) {
    const key = `${userId}|${receiptKey}`;
    if (this.receipts.has(key)) return false;
    this.receipts.add(key);
    return true;
  }
  async insertBroadcast(broadcast: Omit<MailBroadcastRecord, "createdAt">) {
    this.broadcasts.push({ ...structuredClone(broadcast), createdAt: new Date(NOW) });
  }
  async listActiveBroadcasts(now: Date) {
    return this.broadcasts.filter((broadcast) => !broadcast.expiresAt || broadcast.expiresAt > now).map((broadcast) => structuredClone(broadcast));
  }
  async receiptsOf(userId: string, keys: string[]) {
    return new Set(keys.filter((key) => this.receipts.has(`${userId}|${key}`)));
  }
  async accountCreatedAt(userId: string) {
    return this.accounts.get(userId) ?? null;
  }
}

function setup(overrides: Partial<MailConfig> = {}) {
  const clock = new FixedClock(NOW);
  const repo = new InMemoryMailRepository();
  const { kit, wallets, ledger, rewards } = rewardKit(clock);
  const uow = new InMemoryUnitOfWork().register(wallets).register(repo);
  const config = { ...MailConfigSchema.parse({}), ...overrides };
  const pushed: string[] = [];
  let ids = 0;
  const service = new MailService({
    mail: repo,
    rewards,
    ledger,
    rosterCache: new RosterCache(noCache),
    runeCache: new RuneCache(noCache),
    audit: noAudit,
    uow,
    clock,
    config: () => config,
    notifier: { mailChanged: async (userId) => { pushed.push(userId); }, mailBroadcast: async () => { pushed.push("*"); } },
    newMailId: () => `m${String(++ids).padStart(3, "0")}`,
  });
  return { clock, repo, wallets, kit, service, config, pushed };
}

describe("Mail rules", () => {
  it("cleans texts and params", () => {
    assert.equal(cleanMailText("  hi\r\nthere\u0007 ", 80), "hi\nthere");
    assert.equal(cleanMailText("x".repeat(100), 10), "x".repeat(10));
    assert.equal(cleanMailParam("<b>Guild</b>\nName"), " b Guild /b  Name");
    assert.equal(expiryAfter(new Date(NOW), 0), null);
    assert.equal(expiryAfter(new Date(NOW), 2)?.getTime(), NOW + 2 * DAY);
  });
});

describe("Mail service", () => {
  it("delivers the welcome mail once, even after it is claimed and deleted", async () => {
    const { service, wallets } = setup();

    const inbox = await service.getInbox("u1");
    assert.equal(inbox.mails.length, 1);
    assert.equal(inbox.unread, 1);
    assert.equal(inbox.claimable, 1);
    const welcome = inbox.mails[0];
    assert.equal(welcome.titleKey, "text_mail_welcome_title");
    assert.equal(welcome.category, "reward");
    assert.equal(welcome.expiresAt, new Date(NOW + 30 * DAY).toISOString());

    const claimed = await service.claim("u1", welcome.mailId);
    assert.deepEqual(claimed.claimedIds, [welcome.mailId]);
    assert.deepEqual(claimed.grants.currencies, [{ currencyId: "DM", amount: 100 }, { currencyId: "GO", amount: 20000 }]);
    assert.equal(wallets.amount("u1", "DM"), 100);
    assert.equal(claimed.mails[0].claimed, true);
    assert.equal(claimed.mails[0].read, true);
    assert.equal(claimed.claimable, 0);
    await assert.rejects(service.claim("u1", welcome.mailId), isError("MAIL_ALREADY_CLAIMED"));

    const deleted = await service.delete("u1", [welcome.mailId]);
    assert.equal(deleted.mails.length, 0);
    assert.equal((await service.getInbox("u1")).mails.length, 0, "the receipt prevents a second welcome mail");
    assert.equal(wallets.amount("u1", "DM"), 100);
  });

  it("protects unclaimed rewards from deletion and hides expired mails", async () => {
    const { service, clock } = setup({ welcome: { ...MailConfigSchema.parse({}).welcome, enabled: false } });
    await service.send("u1", { title: "Gift", attachments: gems(5), expirationDays: 1 });
    await service.send("u1", { title: "Hello", body: "Plain message" });
    const inbox = await service.getInbox("u1");
    const gift = inbox.mails.find((mail) => mail.title === "Gift")!;
    const hello = inbox.mails.find((mail) => mail.title === "Hello")!;
    assert.equal(hello.attachments, null);

    await assert.rejects(service.delete("u1", [gift.mailId]), isError("MAIL_HAS_REWARDS"));
    await assert.rejects(service.claim("u1", hello.mailId), isError("MAIL_NOTHING_TO_CLAIM"));
    await assert.rejects(service.claim("u2", gift.mailId), isError("MAIL_NOT_FOUND"), "scoped by owner");

    const read = await service.read("u1", [hello.mailId]);
    assert.equal(read.unread, 1);
    const cleaned = await service.deleteRead("u1");
    assert.deepEqual(cleaned.mails.map((mail) => mail.title), ["Gift"]);

    clock.set(NOW + 2 * DAY);
    await assert.rejects(service.claim("u1", gift.mailId), isError("MAIL_EXPIRED"));
    assert.equal((await service.getInbox("u1")).mails.length, 0);
  });

  it("claims all rewards and stops at the first full inventory", async () => {
    const { service, kit, wallets } = setup({ welcome: { ...MailConfigSchema.parse({}).welcome, enabled: false } });
    const rune = (quantity: number): ShopPackPayload => ({ ...gems(1), runes: [{ setId: null, slot: null, tier: 5, quality: null, quantity }] });
    await service.send("u1", { title: "A", attachments: rune(1) });
    await service.send("u1", { title: "B", attachments: rune(2) });
    await service.send("u1", { title: "C", attachments: gems(10) });
    kit.runeRoom = 2;

    const result = await service.claimAll("u1");
    assert.equal(result.claimedIds.length, 1);
    assert.equal(result.stoppedBy, "RUNE_CAPACITY_FULL");
    assert.equal(result.grants.runes.length, 1);
    assert.equal(wallets.amount("u1", "DM"), 1, "the failed mail rolled back");
    assert.equal(result.claimable, 2);

    kit.runeRoom = null;
    const rest = await service.claimAll("u1");
    assert.equal(rest.claimedIds.length, 2);
    assert.equal(rest.stoppedBy, null);
    assert.deepEqual(rest.grants.currencies, [{ currencyId: "DM", amount: 11 }]);
    await assert.rejects(service.claimAll("u1"), isError("MAIL_NOTHING_TO_CLAIM"));
  });

  it("skips duplicate deliveries and pushes the new-mail notice", async () => {
    const { service, pushed, repo } = setup();
    assert.equal(await service.send("u1", { title: "Once" }, { receiptKey: "event:1" }), true);
    assert.equal(await service.send("u1", { title: "Once" }, { receiptKey: "event:1" }), false);
    assert.equal(repo.mails.filter((mail) => mail.title === "Once").length, 1);
    assert.deepEqual(pushed, ["u1"]);
  });

  it("copies broadcasts into existing inboxes and only into new ones when asked", async () => {
    const { service, repo, pushed } = setup({ welcome: { ...MailConfigSchema.parse({}).welcome, enabled: false } });
    repo.accounts.set("old", new Date(NOW - DAY));
    repo.accounts.set("new", new Date(NOW + DAY));

    await service.broadcast({ title: "Compensation", attachments: gems(50) });
    await service.broadcast({ title: "Event", expirationDays: 7 }, true);
    assert.deepEqual(pushed, ["*", "*"]);

    const old = await service.getInbox("old");
    assert.deepEqual(old.mails.map((mail) => mail.title).sort(), ["Compensation", "Event"]);
    assert.equal(old.mails.find((mail) => mail.title === "Compensation")?.category, "gm");
    assert.deepEqual((await service.getInbox("new")).mails.map((mail) => mail.title), ["Event"]);
    assert.equal((await service.summary("old")).unread, 2);
    assert.equal((await service.getInbox("old")).mails.length, 2, "delivered once");
  });

  it("trims the oldest read mails beyond the inbox limit but never pending rewards", async () => {
    const { service, repo, clock } = setup({ inboxLimit: 10, welcome: { ...MailConfigSchema.parse({}).welcome, enabled: false } });
    await service.send("u1", { title: "reward", attachments: gems(1) });
    for (let i = 0; i < 12; i++) {
      clock.set(NOW + (i + 1) * 1000);
      await service.send("u1", { title: `note ${i}` });
      await service.read("u1", repo.mails.map((mail) => mail.id).filter((id) => repo.mails.find((mail) => mail.id === id)?.title !== "reward"));
    }
    const titles = repo.mails.map((mail) => mail.title);
    assert.ok(titles.includes("reward"));
    assert.ok(repo.mails.length <= 11);
  });

  it("rejects bundles with rewards the server cannot grant", () => {
    const { service } = setup();
    assert.throws(() => service.validateAttachments({ ...emptyPayload(), currencies: [{ currencyId: "nope", amount: 1 }] }), isError("INVALID_PAYLOAD"));
    service.validateAttachments(gems(1));
  });
});
