import crypto from "node:crypto";
import { AppError } from "../../../shared/errors/app-error.js";
import { ErrorCode } from "../../../shared/errors/error-codes.js";

/** Store-wide id of one transaction: SHA-256 hex of `<store>:<id>` (tokens can be long; the key has a fixed size). */
export function iapTransactionKey(store: string, id: string): string {
  return crypto.createHash("sha256").update(`${store}:${id}`).digest("hex");
}

/**
 * Account token handed to the store with the purchase (Apple `appAccountToken`, Google `obfuscatedAccountId`): a UUID
 * derived from the user id, so the server can tell that a receipt was bought by this account without exposing the id.
 */
export function iapAccountToken(userId: string): string {
  const hex = crypto.createHash("sha256").update(`iap-account:${userId}`).digest("hex");
  // RFC 4122 layout (version 4 bits, variant 10xx) so every store accepts it as a UUID.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Shop purchase id of a store transaction: retries of the same receipt replay the first response. */
export function iapPurchaseId(transactionKey: string): string {
  return `iap-${transactionKey.slice(0, 48)}`;
}

export const rejected = (detail: string, extra: Record<string, unknown> = {}) =>
  new AppError(ErrorCode.IAP_RECEIPT_REJECTED, { extra: { detail, ...extra } });

export const notConfigured = (detail: string) => new AppError(ErrorCode.IAP_NOT_SUPPORTED, { extra: { detail } });

export const storeUnavailable = (detail: string) => new AppError(ErrorCode.IAP_STORE_UNAVAILABLE, { extra: { detail } });
