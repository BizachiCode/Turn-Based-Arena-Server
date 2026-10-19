// Stage drop rolls (pure, randomness injected). A victory rolls the stage's shared drop table (items, then one rune with
// weighted stars and grade) and the stage's own extra drops. The Unity offline backend mirrors this order
// (`OfflineStageDrops.cs`).

import { pickWeighted, type RandomSource } from "../../shared/kernel/random.js";
import type { CurrencyAmount } from "../../shared/kernel/types.js";
import type { StageDropTable, StageRandomDrop } from "../../config/MapCatalog.js";

/** Rune to generate: stars, grade (1 = Normal .. 5 = Legend) and the set (undefined = any set). */
export type RolledRuneDrop = { tier: number; quality: number; setId?: string };

export type RolledStageDrops = {
  currencies: CurrencyAmount[];
  rune: RolledRuneDrop | null;
};

/** Independent rolls: `chance` each, uniform amount in `min..max`. */
export function rollItemDrops(random: RandomSource, drops: readonly StageRandomDrop[]): CurrencyAmount[] {
  const out: CurrencyAmount[] = [];
  for (const drop of drops) {
    if (random.float() >= drop.chance) continue;
    out.push({ currencyId: drop.currencyId, amount: drop.min + random.int(drop.max - drop.min + 1) });
  }
  return out;
}

/**
 * Rolls a victory's drops. Order (mirrored offline): table items, stage extra drops, then the rune
 * (chance → stars by weight → grade by weight → set).
 */
export function rollStageDrops(random: RandomSource, table: StageDropTable | undefined, extra: readonly StageRandomDrop[]): RolledStageDrops {
  const currencies = [...rollItemDrops(random, table?.items ?? []), ...rollItemDrops(random, extra)];

  const rune = table?.rune;
  if (!rune || random.float() >= rune.chance) return { currencies, rune: null };

  const tier = pickWeighted(random, rune.stars).stars;
  const quality = pickWeighted(random, rune.grades).grade;
  const setId = rune.sets.length > 0 ? rune.sets[random.int(rune.sets.length)] : undefined;
  return { currencies, rune: { tier, quality, ...(setId ? { setId } : {}) } };
}
