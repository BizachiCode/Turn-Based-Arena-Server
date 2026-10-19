import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userShopCounters, userShopPurchases } from "../../infrastructure/database/schema/index.js";
import type { ShopCounter, ShopRepository } from "./shop.ports.js";

export class DrizzleShopRepository extends DrizzleRepository implements ShopRepository {
  constructor(database: Database) {
    super(database);
  }

  async listCounters(userId: string, session?: DbSession): Promise<ShopCounter[]> {
    return this.db(session)
      .select({ itemId: userShopCounters.itemId, windowKey: userShopCounters.windowKey, count: userShopCounters.count })
      .from(userShopCounters)
      .where(eq(userShopCounters.userId, userId));
  }

  async lockCounters(userId: string, itemId: string, windowKeys: string[], session: DbSession): Promise<Map<string, number>> {
    const keys = [...new Set(windowKeys)];
    const db = this.db(session);
    await db.insert(userShopCounters).ignore().values(keys.map((windowKey) => ({ userId, itemId, windowKey, count: 0 })));
    const rows = await db.select({ windowKey: userShopCounters.windowKey, count: userShopCounters.count }).from(userShopCounters)
      .where(and(eq(userShopCounters.userId, userId), eq(userShopCounters.itemId, itemId), inArray(userShopCounters.windowKey, keys)))
      .for("update");
    return new Map(rows.map((row) => [row.windowKey, row.count]));
  }

  async incrementCounter(userId: string, itemId: string, windowKey: string, session: DbSession): Promise<void> {
    await this.db(session).insert(userShopCounters)
      .values({ userId, itemId, windowKey, count: 1 })
      .onDuplicateKeyUpdate({ set: { count: sql`${userShopCounters.count} + 1` } });
  }

  async findPurchaseResponse(userId: string, purchaseId: string, session: DbSession): Promise<unknown | null> {
    const [row] = await this.db(session).select({ response: userShopPurchases.response }).from(userShopPurchases)
      .where(and(eq(userShopPurchases.userId, userId), eq(userShopPurchases.purchaseId, purchaseId))).limit(1).for("update");
    if (!row) return null;
    return typeof row.response === "string" ? JSON.parse(row.response) : row.response;
  }

  async logPurchase(entry: { userId: string; itemId: string; windowKey: string; currencyId: string | null; price: number; firstPurchase: boolean; grants: unknown; purchaseId: string | null; response: unknown }, session: DbSession): Promise<void> {
    await this.db(session).insert(userShopPurchases).values({
      purchaseId: entry.purchaseId,
      response: entry.response ?? null,
      userId: entry.userId,
      itemId: entry.itemId,
      windowKey: entry.windowKey,
      currencyId: entry.currencyId,
      price: entry.price,
      firstPurchase: entry.firstPurchase ? 1 : 0,
      grants: entry.grants ?? null,
    });
  }
}
