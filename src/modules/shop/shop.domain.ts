// Pure shop rules (mirrors ShopItemDefinition / PurchaseLimit / AvailabilityRule in Unity).

import type { PriceEntry, ShopItem, ShopPackPayload } from "../../config/ShopCatalog.js";

/** Key of the lifetime counter (also the window of None/Lifetime/PerAccount scopes). */
export const LIFETIME_WINDOW = "U";

const pad = (value: number) => String(value).padStart(2, "0");
const isoDay = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/**
 * Current limit window of an item (UTC). Daily/Weekly/Monthly windows start at `resetHourUtc`; weeks start on `weekStartsOn` (0 = Sunday).
 * Keys: `D:2026-10-05`, `W:<week start date>`, `M:2026-10`, `U` (lifetime / no window).
 */
export function windowKeyFor(item: ShopItem, now: Date): string {
  const { scope, resetHourUtc, weekStartsOn } = item.limit;
  if (scope !== "Daily" && scope !== "Weekly" && scope !== "Monthly") return LIFETIME_WINDOW;

  const shifted = new Date(now.getTime() - resetHourUtc * 3_600_000);
  if (scope === "Daily") return `D:${isoDay(shifted)}`;
  if (scope === "Monthly") return `M:${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;

  const offset = (shifted.getUTCDay() - weekStartsOn + 7) % 7;
  return `W:${isoDay(new Date(shifted.getTime() - offset * 86_400_000))}`;
}

/** True when the item has a purchase limit (counted window or unique). */
export function hasLimit(item: ShopItem): boolean {
  return item.limit.scope !== "None" || item.limit.uniquePerAccount;
}

export function isAvailable(item: ShopItem, now: Date, activeRotationTags: readonly string[]): boolean {
  const { mode, startUtc, endUtc, rotationTag } = item.availability;
  if (mode === "DateRangeUtc") return (!startUtc || now >= startUtc) && (!endUtc || now < endUtc);
  if (mode === "RotationTag") return !!rotationTag && activeRotationTags.includes(rotationTag);
  return true;
}

/** Base price for the given purchase count in the current window (progressive tiers first). */
export function resolveBasePrice(item: ShopItem, purchasesSoFar: number): PriceEntry {
  let best: PriceEntry | null = null;
  let bestFrom = -1;
  for (const tier of item.progressiveTiers) {
    if (tier?.price && purchasesSoFar >= tier.fromPurchaseIndex && tier.fromPurchaseIndex > bestFrom) {
      best = tier.price;
      bestFrom = tier.fromPurchaseIndex;
    }
  }
  if (best) return { ...best };
  if (item.basePrices.length > 0) return { ...item.basePrices[0] };
  return { kind: "HardCurrency", currencyId: "gem", amount: 0, iapProductId: null, realMoneyDisplay: null };
}

/** Applies the best active discount (lowest resulting amount). */
export function applyDiscounts(item: ShopItem, amount: number, now: Date): number {
  let best = amount;
  for (const discount of item.discounts) {
    if ((discount.startUtc && now < discount.startUtc) || (discount.endUtc && now >= discount.endUtc)) continue;
    let discounted = amount;
    if (discount.mode === "PercentOff") discounted = Math.max(0, amount - Math.floor(amount * (discount.percentOff / 100)));
    else if (discount.mode === "FixedOff") discounted = Math.max(0, amount - discount.fixedOffAmount);
    best = Math.min(best, discounted);
  }
  return Math.max(0, best);
}

/** Final price of the next purchase. */
export function priceFor(item: ShopItem, purchasesInWindow: number, now: Date): PriceEntry {
  const base = resolveBasePrice(item, purchasesInWindow);
  return base.kind === "RealMoneyIAP" ? base : { ...base, amount: applyDiscounts(item, base.amount, now) };
}

/** One building line of a purchase: units to grant and whether the player may own only one. */
export type ConstructionPlan = { buildableId: string; count: number; unique: boolean };

/**
 * Merges the `constructions` of the payloads of one purchase (rewards + first purchase bonus) per buildable.
 * `forceUnique` caps the grant at one unit (the player must not own the building yet, see ShopService).
 */
export function planConstructions(payloads: readonly ShopPackPayload[]): ConstructionPlan[] {
  const plan = new Map<string, ConstructionPlan>();
  for (const payload of payloads) {
    for (const entry of payload.constructions) {
      const count = Math.floor(Number(entry.count));
      if (!(count > 0)) continue;
      const line = plan.get(entry.buildableId) ?? { buildableId: entry.buildableId, count: 0, unique: false };
      line.count += count;
      line.unique ||= entry.forceUnique;
      plan.set(entry.buildableId, line);
    }
  }
  return [...plan.values()].map((line) => (line.unique ? { ...line, count: 1 } : line));
}
