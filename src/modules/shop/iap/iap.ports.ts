// Real-money purchases (shop items priced as RealMoneyIAP): the receipt the client sends, the purchase a store
// verified, the store verifiers and the ledger that delivers every store transaction once. See docs/IAP.md.

import type { IapSettings } from "../../../config/ShopCatalog.js";
import type { DbSession } from "../../../shared/kernel/unit-of-work.js";

/** Stores handled out of the box. Register your own `IapStoreVerifier` for any other store. */
export const IapStore = {
  GooglePlay: "GooglePlay",
  AppleAppStore: "AppleAppStore",
  /** Demo builds: no payment, accepted only while demo purchases are on (`shop.json` iap + `IAP_DEMO_PURCHASES`). */
  Demo: "Demo",
} as const;

/** Receipt sent with `shop/purchase` for a RealMoneyIAP item (Unity `ShopIapReceiptDTO`). */
export type IapReceipt = {
  /** `GooglePlay`, `AppleAppStore`, `Demo` or a custom store name. */
  store: string;
  /** Store product id the player paid for (must be the item's current `iapProductId`). */
  productId: string;
  /** Apple: the transaction id. Demo: a random id per purchase. Google Play: optional (the order id). */
  transactionId?: string | null;
  /** Google Play purchase token. */
  purchaseToken?: string | null;
  /** Apple StoreKit 2 signed transaction (JWS, `jwsRepresentation`). */
  signedTransaction?: string | null;
};

/** A purchase the store confirmed: ready to be delivered once. */
export type VerifiedIapPurchase = {
  store: string;
  productId: string;
  /** Unique id of the store transaction (SHA-256 hex, see `iapTransactionKey`): delivered once across all accounts. */
  transactionKey: string;
  /** Store order / transaction id for support (Google order id, Apple transaction id). */
  orderId: string | null;
  /** `Production`, `Sandbox`, `Test` (Google license tester) or `Demo`. */
  environment: string;
  /** Runs after the grant is committed (Google Play: acknowledges, so the purchase is not refunded). Best effort. */
  afterGrant?: () => Promise<void>;
};

export type IapVerifyInput = { userId: string; receipt: IapReceipt; settings: IapSettings };

/** One store. Throws `AppError` with an `IAP_*` code when the receipt is not a valid, deliverable purchase. */
export interface IapStoreVerifier {
  readonly store: string;
  /**
   * Transaction key the receipt claims, computed without calling the store (null when the receipt lacks the id).
   * Only used to answer a repeated delivery before verifying again; `verify` must return the same key.
   */
  claimedKey(input: IapVerifyInput): string | null;
  verify(input: IapVerifyInput): Promise<VerifiedIapPurchase>;
}

/** Receipt validation used by the shop (default: `StoreIapReceiptValidator`). */
export interface IapReceiptValidator {
  claimedKey(input: IapVerifyInput): string | null;
  verify(input: IapVerifyInput): Promise<VerifiedIapPurchase>;
  /** Demo purchases are accepted right now (Unity export and server `.env`). */
  demoEnabled(settings: IapSettings): boolean;
}

export type IapTransactionRecord = {
  transactionKey: string;
  store: string;
  userId: string;
  itemId: string;
  productId: string;
  /** Shop purchase id of the delivery (its stored response is replayed when the receipt comes back). */
  purchaseId: string;
  orderId: string | null;
  environment: string;
};

/** Ledger of delivered store transactions (`user_iap_transactions`, kept when an account is deleted). */
export interface IapTransactionRepository {
  findOwner(transactionKey: string, session?: DbSession): Promise<{ userId: string; purchaseId: string } | null>;
  /** False when another delivery took the key first. */
  insert(record: IapTransactionRecord, session: DbSession): Promise<boolean>;
}
