// Pure wallet rules (caps, recharge ticks, credits). Mirrored by the Unity offline backend.

import type { CurrencyCfg } from "../../config/CurrencyCatalog.js";
import type { WalletRow } from "./economy.ports.js";

/** Level-scaled cap of a currency (Number.MAX_SAFE_INTEGER when uncapped). */
export function capFor(cfg: CurrencyCfg, accountLevel: number): number {
  if (!cfg.hasCap) return Number.MAX_SAFE_INTEGER;
  let cap = cfg.baseCap || 0;
  if (cfg.capScalesWithLevel && cfg.capIncrementsByLevel?.length) {
    const count = Math.max(0, Math.min(cfg.capIncrementsByLevel.length, Math.max(0, accountLevel - 1)));
    for (let i = 0; i < count; i++) cap += cfg.capIncrementsByLevel[i] || 0;
  }
  return cap;
}

/**
 * Applies pending recharge ticks to `row` in place. Returns true when the row changed.
 * - First recharge ever (`lastTickAt == null`) just stamps `lastTickAt = now`.
 * - Whole intervals since the last tick are granted; the remainder carries over.
 * - Natural recharge always stops at the cap. `canOverflowAboveCap` only lets grants (shop packs, rewards)
 *   go above it; a balance already above the cap is kept but receives no recharge.
 */
export function applyRecharge(row: WalletRow, cfg: CurrencyCfg, accountLevel: number, nowMs: number): boolean {
  if (!cfg.rechargeable) return false;

  if (!row.lastTickAt) {
    row.lastTickAt = new Date(nowMs);
    return true;
  }

  const intervalSec = Math.max(1, Math.floor(cfg.rechargeIntervalSeconds || 0));
  const elapsedSec = Math.floor((nowMs - row.lastTickAt.getTime()) / 1000);
  if (elapsedSec < intervalSec) return false;

  const ticks = Math.floor(elapsedSec / intervalSec);
  let next = row.amount + ticks * Math.max(0, cfg.rechargeAmount || 0);
  next = Math.min(next, Math.max(row.amount, capFor(cfg, accountLevel)));

  row.amount = next;
  row.lastTickAt = new Date(nowMs - (elapsedSec % intervalSec) * 1000);
  return true;
}

/**
 * Balance after granting `delta`: respects the cap unless the currency can overflow, and never
 * reduces a balance that is already above the cap.
 */
export function creditedAmount(current: number, delta: number, cfg: CurrencyCfg | undefined, accountLevel: number): number {
  let next = current + Math.max(0, delta);
  if (cfg && !cfg.canOverflowAboveCap) {
    next = Math.min(next, capFor(cfg, accountLevel));
  }
  return Math.max(current, next);
}

/** Sums amounts per currency, dropping non-positive entries. */
export function mergeAmounts(entries: ReadonlyArray<{ currencyId: string; amount: number }>): Map<string, number> {
  const merged = new Map<string, number>();
  for (const entry of entries) {
    const currencyId = String(entry?.currencyId ?? "").trim();
    const amount = Math.floor(Number(entry?.amount) || 0);
    if (!currencyId || amount <= 0) continue;
    merged.set(currencyId, (merged.get(currencyId) ?? 0) + amount);
  }
  return merged;
}
