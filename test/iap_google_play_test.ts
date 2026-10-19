import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { IapSettingsSchema, type IapSettings } from "../src/config/ShopCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { GooglePlayVerifier, type FetchLike } from "../src/modules/shop/iap/google-play.verifier";
import { iapAccountToken, iapTransactionKey } from "../src/modules/shop/iap/iap.domain";

const USER = "user-1";
const TOKEN = "purchase-token-abc";
const settings: IapSettings = IapSettingsSchema.parse({ googlePackageName: "com.example.arena" });
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  client_email: "iap@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth.test/token",
};

type Call = { url: string; method: string; body?: string; authorization?: string };

/** Fake Google endpoints: the OAuth token route and purchases.products.get / acknowledge. */
function fakeGoogle(purchase: Record<string, unknown> | number) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined, authorization: headers.authorization });
    if (url === account.token_uri) {
      const assertion = new URLSearchParams(init?.body as string).get("assertion")!;
      const claims = jwt.verify(assertion, publicKey.export({ type: "spki", format: "pem" }).toString(), { algorithms: ["RS256"] }) as jwt.JwtPayload;
      assert.equal(claims.iss, account.client_email);
      assert.equal(claims.aud, account.token_uri);
      return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith(":acknowledge")) return new Response("{}", { status: 200 });
    if (typeof purchase === "number") return new Response("{}", { status: purchase });
    return new Response(JSON.stringify(purchase), { status: 200 });
  };
  return { calls, fetchImpl };
}

const receipt = { store: "GooglePlay", productId: "diamond_pack_1", purchaseToken: TOKEN };
const valid = { purchaseState: 0, consumptionState: 0, acknowledgementState: 0, orderId: "GPA.1234-5678", obfuscatedExternalAccountId: iapAccountToken(USER) };
const isError = (code: string, detail?: string) => (error: unknown) =>
  error instanceof AppError && error.errorCode === code && (detail === undefined || error.extra?.detail === detail);

describe("Google Play receipts", () => {
  it("verifies the token with the Android Publisher API and acknowledges after the grant", async () => {
    const google = fakeGoogle(valid);
    const verifier = new GooglePlayVerifier(() => account, google.fetchImpl);
    const result = await verifier.verify({ userId: USER, receipt, settings });

    assert.equal(result.orderId, "GPA.1234-5678");
    assert.equal(result.environment, "Production");
    assert.equal(result.transactionKey, iapTransactionKey("GooglePlay", TOKEN));
    assert.equal(verifier.claimedKey({ userId: USER, receipt, settings }), result.transactionKey);
    const get = google.calls[1];
    assert.equal(get.url, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.arena/purchases/products/diamond_pack_1/tokens/${TOKEN}`);
    assert.equal(get.authorization, "Bearer access-1");

    await result.afterGrant!();
    assert.equal(google.calls.at(-1)!.url, `${get.url}:acknowledge`);
    assert.equal(google.calls.at(-1)!.method, "POST");

    // The access token is cached.
    await verifier.verify({ userId: USER, receipt, settings });
    assert.equal(google.calls.filter((call) => call.url === account.token_uri).length, 1);
  });

  it("skips the acknowledgement of an acknowledged purchase and flags license-tester purchases", async () => {
    const verifier = new GooglePlayVerifier(() => account, fakeGoogle({ ...valid, acknowledgementState: 1, purchaseType: 0 }).fetchImpl);
    const result = await verifier.verify({ userId: USER, receipt, settings });
    assert.equal(result.afterGrant, undefined);
    assert.equal(result.environment, "Test");
    await assert.rejects(verifier.verify({ userId: USER, receipt, settings: { ...settings, allowTestPurchases: false } }),
      isError("IAP_RECEIPT_REJECTED", "TEST_PURCHASE"));
  });

  it("maps the purchase state", async () => {
    const check = (purchase: Record<string, unknown> | number, code: string, detail?: string) =>
      assert.rejects(new GooglePlayVerifier(() => account, fakeGoogle(purchase).fetchImpl).verify({ userId: USER, receipt, settings }), isError(code, detail));
    await check({ ...valid, purchaseState: 2 }, "IAP_PURCHASE_PENDING");
    await check({ ...valid, purchaseState: 1 }, "IAP_RECEIPT_REJECTED", "CANCELLED");
    await check({ ...valid, consumptionState: 1 }, "IAP_RECEIPT_USED", "ALREADY_CONSUMED");
    await check({ ...valid, quantity: 2 }, "IAP_RECEIPT_REJECTED", "MULTI_QUANTITY_NOT_SUPPORTED");
    await check({ ...valid, obfuscatedExternalAccountId: iapAccountToken("someone-else") }, "IAP_RECEIPT_REJECTED", "ACCOUNT_MISMATCH");
    await check(404, "IAP_RECEIPT_REJECTED", "UNKNOWN_PURCHASE");
    await check(403, "IAP_STORE_UNAVAILABLE", "GOOGLE_PLAY_ACCESS_DENIED");
    await check(503, "IAP_STORE_UNAVAILABLE", "GOOGLE_PLAY_ERROR");
  });

  it("keeps the purchase pending while the server is not set up", async () => {
    const google = fakeGoogle(valid);
    await assert.rejects(new GooglePlayVerifier(() => account, google.fetchImpl).verify({ userId: USER, receipt, settings: { ...settings, googlePackageName: null } }),
      isError("IAP_NOT_SUPPORTED", "GOOGLE_PLAY_NOT_CONFIGURED"));
    await assert.rejects(new GooglePlayVerifier(() => null, google.fetchImpl).verify({ userId: USER, receipt, settings }),
      isError("IAP_STORE_UNAVAILABLE", "GOOGLE_PLAY_CREDENTIALS_MISSING"));
    const offline: FetchLike = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(new GooglePlayVerifier(() => account, offline).verify({ userId: USER, receipt, settings }),
      isError("IAP_STORE_UNAVAILABLE", "GOOGLE_PLAY_UNREACHABLE"));
    await assert.rejects(new GooglePlayVerifier(() => account, google.fetchImpl).verify({ userId: USER, receipt: { ...receipt, purchaseToken: undefined } as never, settings }),
      isError("IAP_RECEIPT_REJECTED", "MISSING_PURCHASE_TOKEN"));
  });
});
