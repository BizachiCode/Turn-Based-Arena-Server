// Pure mailbox rules shared by the service (and mirrored by the Unity offline backend `OfflineMailService`).

import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import { hasRewards } from "../rewards/reward-granter.js";

export const MAIL_CATEGORIES = ["system", "guild", "reward", "gm"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/** Field limits (also the column sizes). */
export const MAIL_LIMITS = { sender: 32, title: 80, body: 1000, params: 8, param: 64, key: 64 } as const;

const DAY_MS = 86_400_000;
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** Trims, normalizes newlines, drops control characters (newlines kept) and caps the length. */
export function cleanMailText(raw: string | null | undefined, max: number): string {
  const text = (raw ?? "").replace(/\r\n?/g, "\n").replace(CONTROL_CHARS_EXCEPT_NEWLINE, "").trim();
  return [...text].slice(0, max).join("");
}

/** Template parameter (player/guild names...): single line, no markup characters. */
export function cleanMailParam(raw: string | null | undefined): string {
  return cleanMailText(raw, MAIL_LIMITS.param).replace(/[\n<>]/g, " ");
}

/** Expiration date `days` after `from` (null = never when days <= 0). */
export function expiryAfter(from: Date, days: number): Date | null {
  return days > 0 ? new Date(from.getTime() + days * DAY_MS) : null;
}

export function isExpired(mail: { expiresAt: Date | null }, now: Date): boolean {
  return !!mail.expiresAt && mail.expiresAt.getTime() <= now.getTime();
}

/** True when the mail carries rewards that were not claimed yet. */
export function hasPendingRewards(mail: { attachments: ShopPackPayload | null; claimedAt: Date | null }): boolean {
  return !mail.claimedAt && hasRewards(mail.attachments);
}

/** A mail can be deleted once its rewards were claimed (or it has none, or it expired). */
export function canDelete(mail: { attachments: ShopPackPayload | null; claimedAt: Date | null; expiresAt: Date | null }, now: Date): boolean {
  return !hasPendingRewards(mail) || isExpired(mail, now);
}
