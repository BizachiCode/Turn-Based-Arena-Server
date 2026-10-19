// Default receipt validation of the shop: one verifier per store (Google Play, App Store, Demo). Add a store with
// `register` (see docs/IAP.md, "Adding a store").

import type { IapSettings } from "../../../config/ShopCatalog.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { ErrorCode } from "../../../shared/errors/error-codes.js";
import { iapTransactionKey, notConfigured, rejected } from "./iap.domain.js";
import { IapStore, type IapReceiptValidator, type IapStoreVerifier, type IapVerifyInput, type VerifiedIapPurchase } from "./iap.ports.js";

/**
 * Demo builds: grants the item without any payment. Accepted only while the Unity export turns demo purchases on
 * AND the server allows them (`IAP_DEMO_PURCHASES`, off by default in production). The transaction id is random per
 * purchase and scoped to the account, so retries are idempotent and ids never collide between players.
 */
export class DemoIapVerifier implements IapStoreVerifier {
  readonly store = IapStore.Demo;

  constructor(private readonly enabled: (settings: IapSettings) => boolean) {}

  claimedKey({ userId, receipt }: IapVerifyInput): string | null {
    return receipt.transactionId ? iapTransactionKey(this.store, `${userId}:${receipt.transactionId}`) : null;
  }

  async verify(input: IapVerifyInput): Promise<VerifiedIapPurchase> {
    if (!this.enabled(input.settings)) throw new AppError(ErrorCode.IAP_DEMO_DISABLED);
    const key = this.claimedKey(input);
    if (!key) throw rejected("MISSING_TRANSACTION_ID");
    return { store: this.store, productId: input.receipt.productId, transactionKey: key, orderId: input.receipt.transactionId ?? null, environment: "Demo" };
  }
}

export class StoreIapReceiptValidator implements IapReceiptValidator {
  private readonly stores = new Map<string, IapStoreVerifier>();

  /** @param serverAllowsDemo `IAP_DEMO_PURCHASES` (env): demo receipts also need it, on top of the exported setting. */
  constructor(verifiers: IapStoreVerifier[], private readonly serverAllowsDemo: boolean) {
    for (const verifier of verifiers) this.register(verifier);
    if (!this.stores.has(IapStore.Demo)) this.register(new DemoIapVerifier((settings) => this.demoEnabled(settings)));
  }

  /** Adds (or replaces) the verifier of one store. */
  register(verifier: IapStoreVerifier): this {
    this.stores.set(verifier.store, verifier);
    return this;
  }

  demoEnabled(settings: IapSettings): boolean {
    return settings.demoPurchases && this.serverAllowsDemo;
  }

  claimedKey(input: IapVerifyInput): string | null {
    return this.stores.get(input.receipt.store)?.claimedKey(input) ?? null;
  }

  async verify(input: IapVerifyInput): Promise<VerifiedIapPurchase> {
    const verifier = this.stores.get(input.receipt.store);
    if (!verifier) throw notConfigured("UNKNOWN_STORE");
    const verified = await verifier.verify(input);
    if (verified.productId !== input.receipt.productId) {
      throw new AppError(ErrorCode.IAP_PRODUCT_MISMATCH, { extra: { productId: verified.productId } });
    }
    return verified;
  }
}
