// Google Play purchases: the purchase token is checked with the Android Publisher API (purchases.products.get) using a
// service account of the Play Console, then acknowledged after the grant (unacknowledged purchases are refunded by
// Google after 3 days). Setup: docs/IAP.md.

import fs from "node:fs";
import jwt from "jsonwebtoken";
import { AppError } from "../../../shared/errors/app-error.js";
import { ErrorCode } from "../../../shared/errors/error-codes.js";
import { createLogger } from "../../../shared/logger.js";
import { iapAccountToken, iapTransactionKey, notConfigured, rejected, storeUnavailable } from "./iap.domain.js";
import { IapStore, type IapStoreVerifier, type IapVerifyInput, type VerifiedIapPurchase } from "./iap.ports.js";

const logger = createLogger("GooglePlayIap");

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 10_000;

/** The fields of a service account key file this verifier needs. */
export type GoogleServiceAccount = { client_email: string; private_key: string; token_uri?: string };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `ProductPurchase` of the Android Publisher API (the fields used here). */
type ProductPurchase = {
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  orderId?: string;
  purchaseType?: number;
  quantity?: number;
  obfuscatedExternalAccountId?: string;
};

/** Reads the service account from `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` or `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE` (null when unset). */
export function loadGoogleServiceAccount(inlineJson: string, filePath: string): GoogleServiceAccount | null {
  try {
    const raw = inlineJson.trim() || (filePath ? fs.readFileSync(filePath, "utf8") : "");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GoogleServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) throw new Error("client_email / private_key missing");
    return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
  } catch (error) {
    logger.error("cannot read the Google Play service account key:", (error as Error).message);
    return null;
  }
}

export class GooglePlayVerifier implements IapStoreVerifier {
  readonly store = IapStore.GooglePlay;
  private accessToken: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly account: () => GoogleServiceAccount | null,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly nowMs: () => number = Date.now,
  ) {}

  claimedKey({ receipt }: IapVerifyInput): string | null {
    return receipt.purchaseToken ? iapTransactionKey(this.store, receipt.purchaseToken) : null;
  }

  async verify({ userId, receipt, settings }: IapVerifyInput): Promise<VerifiedIapPurchase> {
    const packageName = settings.googlePackageName;
    if (!packageName) throw notConfigured("GOOGLE_PLAY_NOT_CONFIGURED");
    const token = receipt.purchaseToken;
    if (!token) throw rejected("MISSING_PURCHASE_TOKEN");

    const path = `${API}/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(receipt.productId)}/tokens/${encodeURIComponent(token)}`;
    const response = await this.call(path, "GET");
    if (response.status === 400 || response.status === 404 || response.status === 410) throw rejected("UNKNOWN_PURCHASE");
    if (!response.ok) throw await this.unavailable(response);

    const purchase = (await response.json()) as ProductPurchase;
    if (purchase.purchaseState === 2) throw new AppError(ErrorCode.IAP_PURCHASE_PENDING);
    if (purchase.purchaseState !== 0) throw rejected("CANCELLED");
    // A consumed purchase was delivered already: by this server it is found in the ledger before verifying again.
    if (purchase.consumptionState === 1) throw new AppError(ErrorCode.IAP_RECEIPT_USED, { extra: { detail: "ALREADY_CONSUMED" } });
    const test = purchase.purchaseType === 0;
    if (test && !settings.allowTestPurchases) throw rejected("TEST_PURCHASE");
    if ((purchase.quantity ?? 1) > 1) throw rejected("MULTI_QUANTITY_NOT_SUPPORTED");
    if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== iapAccountToken(userId)) {
      throw rejected("ACCOUNT_MISMATCH");
    }

    const needsAck = purchase.acknowledgementState !== 1;
    return {
      store: this.store,
      productId: receipt.productId,
      transactionKey: iapTransactionKey(this.store, token),
      orderId: purchase.orderId ?? null,
      environment: test ? "Test" : "Production",
      afterGrant: needsAck ? () => this.acknowledge(`${path}:acknowledge`) : undefined,
    };
  }

  private async acknowledge(url: string): Promise<void> {
    const response = await this.call(url, "POST", "{}");
    // 400 = acknowledged meanwhile (the client consumed it): nothing left to do.
    if (!response.ok && response.status !== 400) logger.warn(`acknowledge failed (${response.status}); the client consume acknowledges it too.`);
  }

  private async call(url: string, method: "GET" | "POST", body?: string): Promise<Response> {
    const token = await this.token();
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn("Android Publisher API unreachable:", (error as Error).message);
      throw storeUnavailable("GOOGLE_PLAY_UNREACHABLE");
    }
  }

  /** OAuth access token of the service account (JWT bearer grant), cached until a minute before it expires. */
  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAtMs - 60_000 > this.nowMs()) return this.accessToken.value;
    const account = this.account();
    // Transient on purpose: the purchase stays pending on the device until the server is set up.
    if (!account) throw storeUnavailable("GOOGLE_PLAY_CREDENTIALS_MISSING");

    const tokenUri = account.token_uri || DEFAULT_TOKEN_URI;
    const assertion = jwt.sign({ scope: SCOPE }, account.private_key, {
      algorithm: "RS256",
      issuer: account.client_email,
      audience: tokenUri,
      expiresIn: 3600,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn("Google OAuth unreachable:", (error as Error).message);
      throw storeUnavailable("GOOGLE_PLAY_UNREACHABLE");
    }
    if (!response.ok) {
      logger.error(`Google OAuth refused the service account (${response.status}): check GOOGLE_PLAY_SERVICE_ACCOUNT_*.`);
      throw storeUnavailable("GOOGLE_PLAY_ACCESS_DENIED");
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw storeUnavailable("GOOGLE_PLAY_ACCESS_DENIED");
    this.accessToken = { value: body.access_token, expiresAtMs: this.nowMs() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async unavailable(response: Response): Promise<AppError> {
    if (response.status === 401 || response.status === 403) {
      this.accessToken = null;
      logger.error(`Android Publisher API refused the service account (${response.status}): grant it access to the app in the Play Console.`);
      return storeUnavailable("GOOGLE_PLAY_ACCESS_DENIED");
    }
    logger.warn(`Android Publisher API answered ${response.status}.`);
    return storeUnavailable("GOOGLE_PLAY_ERROR");
  }
}
