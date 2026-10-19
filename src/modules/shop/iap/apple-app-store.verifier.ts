// App Store purchases (iOS, iPadOS, macOS, tvOS, visionOS): the StoreKit 2 signed transaction (JWS) is verified with
// Apple's official library against Apple's root certificates (`certs/apple`), offline except for the optional OCSP
// revocation check. Setup: docs/IAP.md.

import fs from "node:fs";
import path from "node:path";
import { Environment, SignedDataVerifier, VerificationException, VerificationStatus } from "@apple/app-store-server-library";
import { createLogger } from "../../../shared/logger.js";
import { iapAccountToken, iapTransactionKey, notConfigured, rejected, storeUnavailable } from "./iap.domain.js";
import { IapStore, type IapStoreVerifier, type IapVerifyInput, type VerifiedIapPurchase } from "./iap.ports.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { ErrorCode } from "../../../shared/errors/error-codes.js";

const logger = createLogger("AppStoreIap");

/** One-time purchases only (subscriptions need renewal tracking, see docs/IAP.md). */
const DELIVERABLE_TYPES = new Set(["Consumable", "Non-Consumable"]);

/** Every `*.cer` / `*.der` file of the folder (DER). Empty when the folder is missing. */
export function loadAppleRootCertificates(dir: string): Buffer[] {
  try {
    return fs.readdirSync(dir)
      .filter((file) => /\.(cer|der)$/i.test(file))
      .map((file) => fs.readFileSync(path.join(dir, file)));
  } catch {
    logger.warn(`no Apple root certificates in ${dir}: App Store purchases cannot be verified.`);
    return [];
  }
}

/** `environment` of a JWS payload, read without verifying (only picks the verifier, which checks it again). */
function peekEnvironment(jws: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")) as { environment?: unknown };
    return typeof payload.environment === "string" ? payload.environment : null;
  } catch {
    return null;
  }
}

export class AppleAppStoreVerifier implements IapStoreVerifier {
  readonly store = IapStore.AppleAppStore;
  private readonly verifiers = new Map<string, SignedDataVerifier>();

  constructor(private readonly rootCertificates: () => Buffer[], private readonly onlineChecks: boolean) {}

  claimedKey({ receipt }: IapVerifyInput): string | null {
    return receipt.transactionId ? iapTransactionKey(this.store, receipt.transactionId) : null;
  }

  async verify({ userId, receipt, settings }: IapVerifyInput): Promise<VerifiedIapPurchase> {
    const bundleId = settings.appleBundleId;
    if (!bundleId) throw notConfigured("APP_STORE_NOT_CONFIGURED");
    const jws = receipt.signedTransaction;
    if (!jws) throw rejected("MISSING_SIGNED_TRANSACTION");

    const environment = peekEnvironment(jws);
    if (environment !== Environment.PRODUCTION && environment !== Environment.SANDBOX) throw rejected("UNSUPPORTED_ENVIRONMENT", { environment });
    if (environment === Environment.SANDBOX && !settings.allowTestPurchases) throw rejected("TEST_PURCHASE");

    let transaction;
    try {
      transaction = await this.verifier(environment, bundleId, settings.appleAppId).verifyAndDecodeTransaction(jws);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof VerificationException && error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
        logger.warn("Apple OCSP check unreachable:", error.message);
        throw storeUnavailable("APP_STORE_UNREACHABLE");
      }
      const status = error instanceof VerificationException ? VerificationStatus[error.status] : (error as Error).message;
      throw rejected("INVALID_SIGNATURE", { status });
    }

    if (transaction.productId !== receipt.productId) throw new AppError(ErrorCode.IAP_PRODUCT_MISMATCH, { extra: { productId: transaction.productId } });
    if (!transaction.transactionId) throw rejected("MISSING_TRANSACTION_ID");
    if (receipt.transactionId && receipt.transactionId !== transaction.transactionId) throw rejected("TRANSACTION_MISMATCH");
    if (transaction.revocationDate) throw rejected("REFUNDED");
    if (!DELIVERABLE_TYPES.has(String(transaction.type))) throw rejected("UNSUPPORTED_PRODUCT_TYPE", { type: transaction.type });
    if ((transaction.quantity ?? 1) > 1) throw rejected("MULTI_QUANTITY_NOT_SUPPORTED");
    if (transaction.appAccountToken && transaction.appAccountToken.toLowerCase() !== iapAccountToken(userId)) throw rejected("ACCOUNT_MISMATCH");

    return {
      store: this.store,
      productId: transaction.productId,
      transactionKey: iapTransactionKey(this.store, transaction.transactionId),
      orderId: transaction.transactionId,
      environment,
    };
  }

  private verifier(environment: Environment, bundleId: string, appAppleId: number): SignedDataVerifier {
    const key = `${environment}|${bundleId}|${appAppleId}`;
    let verifier = this.verifiers.get(key);
    if (!verifier) {
      const roots = this.rootCertificates();
      if (roots.length === 0) throw storeUnavailable("APPLE_ROOT_CERTIFICATES_MISSING");
      // The app id is only compared for notifications; signed transactions are bound by the bundle id.
      verifier = new SignedDataVerifier(roots, this.onlineChecks, environment, bundleId,
        environment === Environment.PRODUCTION ? appAppleId : undefined);
      this.verifiers.set(key, verifier);
    }
    return verifier;
  }
}
