import { z } from "zod";
import { id, strictPayload } from "../../shared/validation.js";

export const ShopStateSchema = strictPayload({});

export const ShopPurchaseSchema = strictPayload({
  itemId: id(),
  /** Client-generated idempotency key: retrying with the same id never buys twice. */
  purchaseId: z.string().trim().min(8).max(64).nullable().optional(),
  expectedPrice: z.object({
    currencyId: z.string().max(64).nullable().optional(),
    amount: z.number().int().min(0).max(1_000_000_000),
  }).strict().nullable().optional(),
  /** Store receipt of a RealMoneyIAP item (docs/IAP.md). */
  receipt: z.object({
    store: z.string().trim().min(1).max(32),
    productId: z.string().trim().min(1).max(255),
    transactionId: z.string().trim().min(1).max(255).nullable().optional(),
    purchaseToken: z.string().trim().min(1).max(4096).nullable().optional(),
    signedTransaction: z.string().trim().min(1).max(32_768).nullable().optional(),
  }).strict().nullable().optional(),
});

export const ShopIapCheckSchema = strictPayload({ itemId: id() });

export type ShopPurchaseInput = z.infer<typeof ShopPurchaseSchema>;
