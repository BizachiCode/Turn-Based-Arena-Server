import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { ShopCatalog, ShopItem } from "../../config/ShopCatalog.js";

export type ShopCounter = { itemId: string; windowKey: string; count: number };

/** Persistence port for purchase counters and the purchase log. */
export interface ShopRepository {
  listCounters(userId: string, session?: DbSession): Promise<ShopCounter[]>;
  /** Locks the counters of one item (missing rows read as 0). */
  lockCounters(userId: string, itemId: string, windowKeys: string[], session: DbSession): Promise<Map<string, number>>;
  incrementCounter(userId: string, itemId: string, windowKey: string, session: DbSession): Promise<void>;
  logPurchase(entry: {
    userId: string;
    itemId: string;
    windowKey: string;
    currencyId: string | null;
    price: number;
    firstPurchase: boolean;
    grants: unknown;
    /** Client idempotency key (unique per user). */
    purchaseId: string | null;
    /** Response returned to the client (replayed for retries with the same purchaseId). */
    response: unknown;
  }, session: DbSession): Promise<void>;
  /** Stored response of an earlier purchase with the same idempotency key (locked). */
  findPurchaseResponse(userId: string, purchaseId: string, session: DbSession): Promise<unknown | null>;
}

/** Building inventory used by construction rewards (implemented by the home module). */
export interface ConstructionInventory {
  /** True when the buildable exists in the home catalog. */
  exists(buildableId: string): boolean;
  /** Units the player owns (unplaced + placed), read under lock inside the purchase transaction. */
  ownedCount(userId: string, buildableId: string, session: DbSession): Promise<number>;
  /** Adds unplaced units to the player's inventory. */
  grant(userId: string, buildableId: string, count: number, session: DbSession): Promise<void>;
}

export interface ShopCatalogSource {
  catalog(): ShopCatalog;
  get(itemId: string): ShopItem | undefined;
}

// Real-money purchases (receipt validation, transaction ledger): ./iap/iap.ports.ts
