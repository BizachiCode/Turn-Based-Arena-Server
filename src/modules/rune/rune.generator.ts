// Rune generation/upgrade rules (pure, randomness injected). Used by GM grants, stage drops and shop packs.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { pickOne, pickWeighted, type RandomSource } from "../../shared/kernel/random.js";
import type { NewRune, RuneRules, Substat } from "./rune.ports.js";

/** What to generate; omitted fields are rolled randomly. */
export type RuneSpec = {
  setId?: string | null;
  slot?: number | null;
  tier: number;
  variant?: string | null;
  /** 1 = Normal .. 5 = Legendary. */
  quality?: number | null;
  level?: number | null;
  mainStatType?: string | null;
  origin?: string | null;
};

/** Default quality weights for random drops (Normal, Magic, Rare, Hero, Legendary). */
export const DEFAULT_DROP_QUALITY_WEIGHTS: ReadonlyArray<{ quality: number; weight: number }> = [
  { quality: 1, weight: 40 },
  { quality: 2, weight: 30 },
  { quality: 3, weight: 18 },
  { quality: 4, weight: 9 },
  { quality: 5, weight: 3 },
];

export class RuneGenerator {
  constructor(
    private readonly rules: RuneRules,
    private readonly random: RandomSource,
  ) {}

  /** Builds a rune from a spec (uid must be assigned by the caller). */
  generate(spec: RuneSpec, uid: string): NewRune {
    const catalog = this.rules.catalog();

    const setId = spec.setId || (catalog.sets.length > 0 ? pickOne(this.random, catalog.sets).id : null);
    if (!setId) throw new AppError(ErrorCode.RUNE_INVALID_PAYLOAD, { detail: "NO_RUNE_SETS" });
    if (spec.setId && !catalog.sets.some((set) => set.id === spec.setId)) {
      throw new AppError(ErrorCode.RUNE_INVALID_PAYLOAD, { detail: "UNKNOWN_SET" });
    }

    const slot = clamp(spec.slot ?? 1 + this.random.int(6), 1, 6);
    const tier = clamp(spec.tier, 1, 6);
    const variant = spec.variant || "Normal";
    const quality = clamp(spec.quality ?? pickWeighted(this.random, DEFAULT_DROP_QUALITY_WEIGHTS).quality, 1, 5);
    const level = clamp(spec.level ?? 0, 0, catalog.config.maxLevel);

    let mainStatType = (spec.mainStatType || "").trim();
    if (!mainStatType || !this.rules.isMainStatAllowed(slot, mainStatType)) {
      const rule = catalog.slotRules.find((entry) => entry.slot === slot);
      if (!rule?.allowedMainStats?.length) throw new AppError(ErrorCode.RUNE_INVALID_PAYLOAD, { detail: "NO_MAINSTAT_RULE_FOR_SLOT" });
      mainStatType = pickOne(this.random, rule.allowedMainStats);
    }

    // initialSubstatsByQuality is indexed Normal=0 .. Legendary=4 (quality is stored 1..5).
    const wanted = clamp(catalog.config.initialSubstatsByQuality?.[quality - 1] ?? 0, 0, 4);
    const candidates = this.rollableSubstats(tier, variant).filter((stat) => stat !== mainStatType);
    const substats: Substat[] = [];
    while (substats.length < wanted && candidates.length > 0) {
      const index = this.random.int(candidates.length);
      const stat = candidates.splice(index, 1)[0];
      substats.push({ stat, value: this.rollSubstatValue(stat, tier, variant) });
    }

    return {
      uid,
      setId,
      slot,
      tier,
      variant,
      quality,
      level,
      mainStatType,
      mainStatValue: this.rules.mainStatValue(mainStatType, tier, variant, level) || 0,
      substats,
      origin: spec.origin ?? null,
    };
  }

  /**
   * Rolls one upgrade attempt. On success the level increases; breakpoints add a substat (or
   * enhance a random one when 4 already exist). Returns the new state (input is not mutated).
   */
  rollUpgrade(rune: { level: number; tier: number; variant: string; mainStatType: string; mainStatValue: number; substats: Substat[] }) {
    const chance = Math.max(0, Math.min(100, this.rules.upgradeSuccessChance(rune.level)));
    const success = this.random.int(100) < chance;
    if (!success) {
      return { success, level: rune.level, mainStatValue: rune.mainStatValue, substats: rune.substats.map((entry) => ({ ...entry })) };
    }

    const level = rune.level + 1;
    const substats = rune.substats.map((entry) => ({ ...entry }));
    if ((this.rules.catalog().config.upgradeBreakpoints || []).includes(level)) {
      if (substats.length < 4) {
        const candidates = this.rollableSubstats(rune.tier, rune.variant)
          .filter((stat) => stat !== rune.mainStatType && !substats.some((entry) => entry.stat === stat));
        if (candidates.length > 0) {
          const stat = pickOne(this.random, candidates);
          substats.push({ stat, value: Math.max(0, this.rollSubstatValue(stat, rune.tier, rune.variant)) });
        }
      } else {
        const index = this.random.int(substats.length);
        const current = substats[index];
        current.value = Math.max(0, (current.value || 0) + Math.max(0, this.rollSubstatValue(current.stat, rune.tier, rune.variant)));
      }
    }

    return {
      success,
      level,
      mainStatValue: this.rules.mainStatValue(rune.mainStatType, rune.tier, rune.variant, level) || 0,
      substats,
    };
  }

  private rollableSubstats(tier: number, variant: string): string[] {
    const stats = this.rules.catalog().substatRolls
      .filter((roll) => roll && roll.tier === tier && String(roll.variant) === String(variant))
      .map((roll) => String(roll.stat));
    return [...new Set(stats)];
  }

  private rollSubstatValue(stat: string, tier: number, variant: string): number {
    const roll = this.rules.substatRoll(stat, tier, variant);
    if (!roll) return 0;
    if (roll.discreteOptions && roll.discreteOptions.length > 0) return pickOne(this.random, roll.discreteOptions);
    const lo = Math.min(Number(roll.min ?? 0), Number(roll.max ?? 0));
    const hi = Math.max(Number(roll.min ?? 0), Number(roll.max ?? 0));
    return lo + this.random.int(hi - lo + 1);
  }
}

function clamp(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}
