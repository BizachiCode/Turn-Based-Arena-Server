# Real-money purchases (IAP)

Shop items whose price is `RealMoneyIAP` are paid with real money in the platform store and delivered by the server
only after it has verified the store receipt. This page covers setup, the demo mode and how to add a store. The
messages are in [`PROTOCOL.md`](PROTOCOL.md) under [`shop`](PROTOCOL.md#shop).

## How a purchase works

1. The client asks `shop/iap_check { itemId }`. The server runs every purchase check (availability, eligibility,
   limits, unique buildings) without charging, and answers the store `productId`, the `demo` flag and an
   `accountToken`.
2. **Demo mode:** the client sends `shop/purchase` with a `Demo` receipt. No store is involved.
   **Otherwise:** Unity IAP v5 (`com.unity.purchasing`) opens the store payment, passing the `accountToken` as Apple's
   `appAccountToken` or Google's `obfuscatedAccountId`.
3. The client sends the receipt with `shop/purchase`. The server verifies it with the store, records the transaction
   in `user_iap_transactions` and grants the item in the same database transaction.
4. The client confirms the order at the store only after the server has delivered it. If the app is closed or the
   server is down in between, the store hands the order back on the next launch and the client sends it again. The
   server then answers the first response, so nothing is granted twice.

| Store | What the client sends | What the server checks |
|---|---|---|
| Google Play (Android) | `purchaseToken` (+ order id) | `purchases.products.get` of the Android Publisher API: purchased, not consumed, package name, product, account token, license-tester flag. It acknowledges the purchase after the grant (Google refunds purchases left unacknowledged for 3 days). |
| App Store (iOS, iPadOS, macOS, tvOS, visionOS) | StoreKit 2 `signedTransaction` (JWS) + `transactionId` | Signature chain up to Apple Root CA - G3 (`certs/apple`), App Store marker extensions, bundle id, environment, product, not refunded, one-time product, account token. Apple's official `@apple/app-store-server-library` does this. |
| Demo | random `transactionId` | Demo purchases are on (see below). |

Each transaction is delivered once across all accounts. The rows of `user_iap_transactions` have no foreign key and
are kept when an account is deleted: an Apple signed transaction stays valid forever and could otherwise be replayed
on a new account.

## Setup

Product ids are the `Iap Product Id` of the shop item prices in Unity. Use the same id in every store. The Unity
`ShopCatalog` asset (section **Real-money purchases (IAP)**) holds the rest, and `Export Server Config` sends it in
`shop.json` (`iap` block):

| Field | Meaning |
|---|---|
| `Demo Purchases` | Grants real-money items without payment (demo builds). |
| `Allow Test Purchases` | Accepts Apple Sandbox / TestFlight and Google license-tester purchases. Keep it on: App Review buys in the Sandbox. |
| `Google Package Name` | Android application id. Empty = the Android identifier of the Player Settings. |
| `Apple Bundle Id` | iOS / macOS bundle id. Empty = the iOS identifier of the Player Settings. |
| `Apple App Id` | Numeric Apple ID of the app. Optional for purchases. |

### Google Play

1. In Google Cloud, create a service account in the project linked to your Play Console and download a JSON key.
2. In the Play Console, open **Users and permissions**, invite the service account email and give it access to the app
   with the permission **View financial data, orders and cancellation survey responses** and **Manage orders and
   subscriptions**.
3. Set `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE=/path/to/key.json` (or paste the JSON in `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`)
   in the server `.env`, then restart.
4. Create the in-app products in the Play Console with the same ids as Unity. Test with license-tester accounts.

Without credentials the server answers `IAP_STORE_UNAVAILABLE` and the order stays pending on the phone, so it is
delivered once the server is set up. If that takes more than 3 days, Google refunds it.

### App Store

1. Create the in-app purchases in App Store Connect with the same ids as Unity (Consumable, or Non-Consumable for
   items limited to once per account).
2. Make sure the bundle id in Unity (or `Apple Bundle Id`) is the app's bundle id.
3. Nothing secret is needed. `certs/apple/AppleRootCA-G3.cer` (Apple's public root, from
   https://www.apple.com/certificateauthority/) is already in the server. `APPLE_IAP_ONLINE_CHECKS=true` (the default)
   also checks certificate revocation online.
4. Test with Sandbox accounts or TestFlight. Those purchases need `Allow Test Purchases`.

Purchases made in Xcode with a local StoreKit configuration file are signed locally and cannot be verified. Use the
Sandbox instead.

## Demo mode

For demo builds (Editor, PC, WebGL, an APK outside Google Play), turn on `ShopCatalog > Iap > Demo Purchases` and export.
Real-money items then show a "Demo purchase: no payment is made." note and are granted without any store. This works on
the WebSocket server and on the Offline backend.

- Outside production (`NODE_ENV` other than `production`) the server follows the export.
- With `NODE_ENV=production`, the server also needs `IAP_DEMO_PURCHASES=true` in its `.env`. A live game exported with
  the toggle on by mistake therefore still refuses demo receipts (`IAP_DEMO_DISABLED`). Set it only on a demo server.
- Demo transaction ids are scoped to the account, and every demo receipt is delivered once.
- The server logs a warning on boot and on every import while the export has demo purchases on.

## Offline backend

There is no server to ask, so the Offline backend applies the same rules but trusts the device store. Google Play and
App Store receipts are accepted because the store verified them on the device. `Demo` receipts need the toggle. The
Editor test store of Unity IAP is accepted inside the Editor only. Each transaction is delivered once
(`OfflinePlayerData.iapTransactions`).

## Adding a store

A store is one `IapStoreVerifier` (`src/modules/shop/iap/iap.ports.ts`):

```ts
import { iapTransactionKey, rejected } from "./iap.domain.js";
import type { IapStoreVerifier, IapVerifyInput, VerifiedIapPurchase } from "./iap.ports.js";

export class MyStoreVerifier implements IapStoreVerifier {
  readonly store = "MyStore"; // the `receipt.store` the client sends

  claimedKey({ receipt }: IapVerifyInput): string | null {
    return receipt.transactionId ? iapTransactionKey(this.store, receipt.transactionId) : null;
  }

  async verify({ userId, receipt, settings }: IapVerifyInput): Promise<VerifiedIapPurchase> {
    const ok = await callMyStoreApi(receipt.transactionId, receipt.productId); // your store's server API
    if (!ok) throw rejected("UNKNOWN_PURCHASE");
    return {
      store: this.store,
      productId: receipt.productId,
      transactionKey: iapTransactionKey(this.store, receipt.transactionId!),
      orderId: receipt.transactionId ?? null,
      environment: "Production",
    };
  }
}
```

Register it in `createIapValidator` (`src/app/container.ts`):
`new StoreIapReceiptValidator([..., new MyStoreVerifier()], config.iap.demoPurchases)`, or call
`validator.register(new MyStoreVerifier())`. On the client, `IapStoreClient.BuildReceipt` sends the store name that
Unity IAP reports, so a custom Unity IAP store only needs that name to match `store`.

Throw `IAP_STORE_UNAVAILABLE` (`storeUnavailable(...)`) for errors that may go away, such as the store being down or
missing credentials. The client keeps the order and retries. Throw `IAP_RECEIPT_REJECTED` (`rejected(...)`) for
receipts that will never be valid.

## Not covered

- **Subscriptions.** They are rejected (`UNSUPPORTED_PRODUCT_TYPE`). Renewals need Apple App Store Server
  Notifications and Google Real-time Developer Notifications. The Apple library already decodes notifications
  (`verifyAndDecodeNotification`).
- **Refunds after delivery.** They are not revoked automatically. Use the same notifications to take items back if your
  game needs it.
