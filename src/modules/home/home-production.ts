// Pure rules of the home production buildings (docs/PROTOCOL.md `home`). Integer math only: the Unity offline backend
// (`HomeProductionRules`) mirrors these formulas 1:1, so keep both in sync.

import { isActiveProduction, type HomeProductionCfg } from "../../config/HomeCatalog.js";

export { isActiveProduction };

const SECONDS_PER_HOUR = 3600n;

/**
 * Amount stored in a building since `sinceUnix`: `min(capacity, floor(elapsed * amountPerHour / 3600))`.
 * For unit EXP producers it is the EXP each stationed monster has accrued. 0 for inactive configs.
 */
export function storedAt(cfg: HomeProductionCfg, sinceUnix: number, nowUnix: number): number {
  if (!isActiveProduction(cfg)) return 0;
  const elapsed = BigInt(Math.max(0, Math.floor(nowUnix) - Math.floor(sinceUnix)));
  const accrued = (elapsed * BigInt(Math.floor(cfg.amountPerHour))) / SECONDS_PER_HOUR;
  const capacity = BigInt(Math.floor(cfg.capacity));
  return Number(accrued < capacity ? accrued : capacity);
}

/**
 * New accrual anchor after `collected` units were taken: a full building restarts from `nowUnix`; otherwise the
 * anchor advances by the time those units took, keeping the partial progress toward the next one.
 */
export function nextAnchor(cfg: HomeProductionCfg, sinceUnix: number, nowUnix: number, collected: number): number {
  const now = Math.floor(nowUnix);
  if (!isActiveProduction(cfg)) return now;

  const taken = Math.max(0, Math.floor(collected));
  if (taken >= Math.floor(cfg.capacity)) return now;

  const rate = BigInt(Math.floor(cfg.amountPerHour));
  const spent = (BigInt(taken) * SECONDS_PER_HOUR + rate - 1n) / rate; // ceil(taken * 3600 / amountPerHour)
  const anchor = BigInt(Math.floor(sinceUnix)) + spent;
  return anchor < BigInt(now) ? Number(anchor) : now;
}
