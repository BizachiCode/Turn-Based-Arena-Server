import type { SummonScroll } from "../../config/SummonCatalog.js";
import type { CurrencyCfg } from "../../config/CurrencyCatalog.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Summon scroll definitions (`summons.json`). */
export interface SummonRules {
  get(scrollId: string): SummonScroll | undefined;
  /** Tutorial guaranteed monsters of a scroll, in summon order (empty when none). */
  guaranteed?(scrollId: string): readonly string[];
}

/** Summons made by a player per scroll (scoped by the authenticated user). */
export interface SummonCounterRepository {
  /** Summons made with the scroll so far (locks the row inside the transaction). */
  count(userId: string, scrollId: string, session: DbSession): Promise<number>;
  add(userId: string, scrollId: string, amount: number, session: DbSession): Promise<void>;
}

/** Currency lookup used to resolve which wallet entry a scroll consumes. */
export interface SummonCurrencyLookup {
  get(currencyId: string): CurrencyCfg | undefined;
}
