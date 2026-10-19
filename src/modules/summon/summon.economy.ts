// Resolves the price/output of a summon scroll exported by Unity (`summons.json`).

import type { SummonScroll } from "../../config/SummonCatalog.js";
import type { SummonCurrencyLookup } from "./summon.ports.js";

export type SummonEconomy = {
  currencyId: string;
  costSingle: number;
  costTenPlusOne: number;
  /** Characters granted by a multi summon (10+1 by default). */
  multiGive: number;
  /** False when the scroll has no 10+1 offer (`multiGive <= 1` or `costTenPlusOne <= 0`). */
  multiEnabled: boolean;
};

export function resolveSummonEconomy(scrollId: string, scroll: SummonScroll | undefined, currencies: SummonCurrencyLookup): SummonEconomy {
  const explicit = scroll?.currencyId;
  const candidates = [explicit, `${scrollId}_currency`, scrollId, `${scrollId}_scroll`].filter((id): id is string => !!id);
  const currencyId = candidates.find((id) => !!currencies.get(id)) ?? explicit ?? `${scrollId}_currency`;

  const costTenPlusOne = Number(scroll?.tenPlusOneCost ?? 10);
  const multiGive = Math.max(1, Math.floor(Number(scroll?.multiGive ?? 11)));

  return {
    currencyId,
    costSingle: Math.max(0, Number(scroll?.costPerSummon ?? 1)),
    costTenPlusOne: Math.max(0, costTenPlusOne),
    multiGive,
    multiEnabled: multiGive > 1 && costTenPlusOne > 0,
  };
}
