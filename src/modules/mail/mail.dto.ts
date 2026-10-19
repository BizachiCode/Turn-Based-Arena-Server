// Wire shapes of the `mail` room (docs/PROTOCOL.md `mail`; Unity `MailDTOs.cs`).

import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";
import type { MailCategory } from "./mail.domain.js";

/** One mail. Dates are ISO UTC. */
export type MailDto = {
  mailId: string;
  category: MailCategory;
  sender: string;
  title: string;
  body: string;
  titleKey: string | null;
  bodyKey: string | null;
  params: string[];
  /** Rewards (shop payload shape), null for plain messages. */
  attachments: ShopPackPayload | null;
  createdAt: string;
  expiresAt: string | null;
  read: boolean;
  claimed: boolean;
};

/** `mail/list` and the response of every mutation. */
export type MailInboxDto = {
  ok: true;
  serverTime: string;
  mails: MailDto[];
  /** Unread mails. */
  unread: number;
  /** Mails with rewards to claim. */
  claimable: number;
  inboxLimit: number;
};

/** `mail/claim` and `mail/claimAll`. */
export type MailClaimDto = MailInboxDto & {
  claimedIds: string[];
  grants: ShopGrantsDto;
  wallet: WalletSnapshot;
  /** `claimAll` only: error that stopped the remaining claims (e.g. RUNE_CAPACITY_FULL); null when all were claimed. */
  stoppedBy: string | null;
};

/** `mail/summary` (badge). */
export type MailSummaryDto = { ok: true; unread: number; claimable: number };
