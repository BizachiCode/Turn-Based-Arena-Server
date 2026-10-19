import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";

import { IapSettingsSchema, type IapSettings } from "../src/config/ShopCatalog";
import { AppError } from "../src/shared/errors/app-error";
import { AppleAppStoreVerifier, loadAppleRootCertificates } from "../src/modules/shop/iap/apple-app-store.verifier";
import { iapAccountToken, iapTransactionKey } from "../src/modules/shop/iap/iap.domain";

// Test chain from test/fixtures/apple/generate.sh: same marker extensions as Apple's App Store chain, local root.
const FIXTURES = path.resolve("test/fixtures/apple");
const pemBody = (file: string) => fs.readFileSync(path.join(FIXTURES, file), "utf8").replace(/-----[^-]+-----|\s/g, "");
const TEST_ROOT = fs.readFileSync(path.join(FIXTURES, "root.cer"));
const CHAIN = [pemBody("leaf.pem"), pemBody("intermediate.pem"), pemBody("root.pem")];
const ROGUE_CHAIN = [pemBody("rogue.pem"), pemBody("intermediate.pem"), pemBody("root.pem")];

const USER = "6552f792-aeaa-476e-bd14-158c00b8a5eb";
const settings: IapSettings = IapSettingsSchema.parse({ appleBundleId: "com.example.arena", appleAppId: 1234567890 });

function signed(payload: Record<string, unknown>, options: { chain?: string[]; key?: string } = {}): string {
  const body = {
    transactionId: "2000000123456789",
    originalTransactionId: "2000000123456789",
    bundleId: "com.example.arena",
    productId: "diamond_pack_1",
    purchaseDate: Date.now(),
    signedDate: Date.now(),
    type: "Consumable",
    quantity: 1,
    environment: "Production",
    inAppOwnershipType: "PURCHASED",
    appAccountToken: iapAccountToken(USER),
    ...payload,
  };
  const key = options.key ?? fs.readFileSync(path.join(FIXTURES, "leaf.key.pem"), "utf8");
  return jwt.sign(body, key, { algorithm: "ES256", header: { alg: "ES256", x5c: options.chain ?? CHAIN } as jwt.JwtHeader });
}

const verifier = () => new AppleAppStoreVerifier(() => [TEST_ROOT], false);
const receipt = (jws: string, extra: Record<string, unknown> = {}) =>
  ({ store: "AppleAppStore", productId: "diamond_pack_1", transactionId: "2000000123456789", signedTransaction: jws, ...extra });
const isError = (code: string, detail?: string) => (error: unknown) =>
  error instanceof AppError && error.errorCode === code && (detail === undefined || error.extra?.detail === detail);

describe("App Store receipts", () => {
  it("ships Apple Root CA - G3 (SHA-256 pinned)", () => {
    const roots = loadAppleRootCertificates(path.resolve("certs/apple"));
    assert.equal(roots.length, 1);
    assert.equal(new crypto.X509Certificate(roots[0]).fingerprint256,
      "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79");
  });

  it("verifies a signed transaction and keys it by transaction id", async () => {
    const result = await verifier().verify({ userId: USER, receipt: receipt(signed({})), settings });
    assert.equal(result.productId, "diamond_pack_1");
    assert.equal(result.orderId, "2000000123456789");
    assert.equal(result.environment, "Production");
    assert.equal(result.transactionKey, iapTransactionKey("AppleAppStore", "2000000123456789"));
    assert.equal(verifier().claimedKey({ userId: USER, receipt: receipt("x"), settings }), result.transactionKey);
  });

  it("accepts Sandbox (TestFlight / App Review) only while test purchases are allowed", async () => {
    const jws = signed({ environment: "Sandbox" });
    assert.equal((await verifier().verify({ userId: USER, receipt: receipt(jws), settings })).environment, "Sandbox");
    await assert.rejects(verifier().verify({ userId: USER, receipt: receipt(jws), settings: { ...settings, allowTestPurchases: false } }),
      isError("IAP_RECEIPT_REJECTED", "TEST_PURCHASE"));
    await assert.rejects(verifier().verify({ userId: USER, receipt: receipt(signed({ environment: "Xcode" })), settings }),
      isError("IAP_RECEIPT_REJECTED", "UNSUPPORTED_ENVIRONMENT"));
  });

  it("rejects forged, foreign or unusable transactions", async () => {
    const v = verifier();
    const check = (jws: string, code: string, detail?: string, extra: Record<string, unknown> = {}) =>
      assert.rejects(v.verify({ userId: USER, receipt: receipt(jws, extra), settings }), isError(code, detail));

    // Payload edited after signing.
    const [header, , signature] = signed({}).split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...jwt.decode(signed({})) as object, productId: "diamond_pack_4" })).toString("base64url");
    await check(`${header}.${forgedPayload}.${signature}`, "IAP_RECEIPT_REJECTED", "INVALID_SIGNATURE", { productId: "diamond_pack_4" });
    // Signed by a certificate of the same CA without the App Store marker extension.
    await check(signed({}, { chain: ROGUE_CHAIN, key: fs.readFileSync(path.join(FIXTURES, "rogue.key.pem"), "utf8") }), "IAP_RECEIPT_REJECTED", "INVALID_SIGNATURE");
    await check(signed({ bundleId: "com.other.game" }), "IAP_RECEIPT_REJECTED", "INVALID_SIGNATURE");
    await check(signed({ productId: "diamond_pack_2" }), "IAP_PRODUCT_MISMATCH");
    await check(signed({}), "IAP_RECEIPT_REJECTED", "TRANSACTION_MISMATCH", { transactionId: "2000000999999999" });
    await check(signed({ revocationDate: Date.now() }), "IAP_RECEIPT_REJECTED", "REFUNDED");
    await check(signed({ type: "Auto-Renewable Subscription" }), "IAP_RECEIPT_REJECTED", "UNSUPPORTED_PRODUCT_TYPE");
    await check(signed({ appAccountToken: iapAccountToken("someone-else") }), "IAP_RECEIPT_REJECTED", "ACCOUNT_MISMATCH");
    await check(signed({ quantity: 3 }), "IAP_RECEIPT_REJECTED", "MULTI_QUANTITY_NOT_SUPPORTED");
    await check("", "IAP_RECEIPT_REJECTED", "MISSING_SIGNED_TRANSACTION");
  });

  it("accepts a transaction bought without an account token (promoted in the App Store)", async () => {
    const result = await verifier().verify({ userId: USER, receipt: receipt(signed({ appAccountToken: undefined })), settings });
    assert.equal(result.orderId, "2000000123456789");
  });

  it("answers IAP_NOT_SUPPORTED without a bundle id and IAP_STORE_UNAVAILABLE without root certificates", async () => {
    await assert.rejects(verifier().verify({ userId: USER, receipt: receipt(signed({})), settings: { ...settings, appleBundleId: null } }),
      isError("IAP_NOT_SUPPORTED", "APP_STORE_NOT_CONFIGURED"));
    await assert.rejects(new AppleAppStoreVerifier(() => [], false).verify({ userId: USER, receipt: receipt(signed({})), settings }),
      isError("IAP_STORE_UNAVAILABLE", "APPLE_ROOT_CERTIFICATES_MISSING"));
  });
});
