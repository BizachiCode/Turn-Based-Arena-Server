// Monster progression rules: EXP curves, power-up EXP yield/price, evolve requirements.
// Pure functions over the rules exported from Unity (`config.json > gameplay`), so the Unity
// offline backend can mirror them 1:1.

export type StarTierRule = {
  stars: number;
  maxLevel: number;
  /** EXP needed for Lv.1->2 at index 0, Lv.2->3 at index 1, ... */
  expPerLevel: number[];
};

export type PowerUpRules = {
  currencyId: string;
  costPerFodderStarUnit: number;
  /** Yield per fodder tier: `baseExp` (flat) + accumulated EXP x `factor`. */
  expMultiplierByStars: Array<{ stars: number; factor: number; baseExp?: number }>;
  minFodderBaseLevel: number;
};

export type EvolveRules = {
  currencyId: string;
  costPerStarUnit: number;
  steps: Array<{ fromStars: number; toStars: number; requiredStarPoints: number }>;
};

/** Read access to the live progression rules. */
export interface ProgressionRulesSource {
  starTiers(): StarTierRule[];
  powerUp(): PowerUpRules;
  evolve(): EvolveRules;
}

export type LevelUpResult = {
  finalLevel: number;
  finalExp: number;
  levelsGained: number;
  /** Portion of the extra EXP actually used (clamped by max level). */
  expConsumed: number;
};

const clampStars = (stars: number) => Math.max(1, Math.min(6, stars | 0));

/** Monster progression calculator bound to a rules source. */
export class MonsterProgression {
  constructor(private readonly rules: ProgressionRulesSource) {}

  private tier(stars: number): StarTierRule | null {
    return this.rules.starTiers().find((tier) => tier.stars === clampStars(stars)) ?? null;
  }

  /** Max level of a star tier (1 when the tier is unknown). */
  maxLevelForStars(stars: number): number {
    const tier = this.tier(stars);
    return tier ? Math.max(1, tier.maxLevel | 0) : 1;
  }

  /** EXP required to go from `level` to `level + 1` (0 at max level). */
  expToNextLevel(stars: number, level: number): number {
    const tier = this.tier(stars);
    if (!tier) return 0;
    if (level >= Math.max(1, tier.maxLevel | 0)) return 0;

    const curve = Array.isArray(tier.expPerLevel) ? tier.expPerLevel : [];
    const index = Math.max(1, Math.min(level, curve.length)) - 1;
    return Math.max(0, (curve[index] ?? 0) | 0);
  }

  /** Accumulated EXP needed to reach `level` from Lv.1. */
  accumulatedExp(stars: number, level: number): number {
    const tier = this.tier(stars);
    if (!tier || level <= 1) return 0;

    const curve = Array.isArray(tier.expPerLevel) ? tier.expPerLevel : [];
    const steps = Math.min(curve.length, Math.max(0, level - 1));
    let total = 0;
    for (let i = 0; i < steps; i++) total += curve[i] ?? 0;
    return Math.max(0, total | 0);
  }

  /** EXP a fodder yields in power-up (mirrors the Unity preview). */
  powerUpExpYield(fodderStars: number, fodderLevel: number): number {
    const powerUp = this.rules.powerUp();
    const baseLevel = Math.max(powerUp.minFodderBaseLevel ?? 2, Math.max(1, fodderLevel | 0));
    const base = this.accumulatedExp(fodderStars | 0, baseLevel | 0);
    const multiplier = powerUp.expMultiplierByStars.find((entry) => (entry?.stars | 0) === (fodderStars | 0));
    const factor = multiplier ? Math.max(0, Number(multiplier.factor) || 0) : 1;
    const flat = multiplier ? Math.max(0, Math.floor(Number(multiplier.baseExp) || 0)) : 0;
    return flat + Math.max(0, Math.floor(Math.max(0, base) * factor));
  }

  /** Applies extra EXP, clamped at the tier max level (EXP resets to 0 at max). */
  applyExp(stars: number, currentLevel: number, currentExp: number, extraExp: number): LevelUpResult {
    const maxLevel = this.maxLevelForStars(stars | 0);
    let level = Math.max(1, Math.min(maxLevel, currentLevel | 0));
    let exp = Math.max(0, currentExp | 0);
    let pool = Math.max(0, extraExp | 0);
    let gained = 0;
    let consumed = 0;

    while (level < maxLevel) {
      const need = this.expToNextLevel(stars, level);
      if (need <= 0) break;

      if (exp + pool >= need) {
        const delta = need - exp;
        consumed += delta;
        pool -= delta;
        level += 1;
        exp = 0;
        gained += 1;
      } else {
        exp += pool;
        consumed += pool;
        pool = 0;
        break;
      }
    }

    if (level >= maxLevel) exp = 0;
    return { finalLevel: level, finalExp: exp, levelsGained: gained, expConsumed: consumed };
  }

  /** Power-up price for a set of fodders. */
  powerUpPrice(fodderStars: number[]): { currencyId: string; price: number } {
    const powerUp = this.rules.powerUp();
    const unit = Math.max(0, powerUp.costPerFodderStarUnit | 0);
    const price = fodderStars.reduce((sum, stars) => sum + unit * clampStars(stars), 0);
    return { currencyId: powerUp.currencyId || "GO", price: Math.max(0, price) };
  }

  /** Evolve requirement from `fromStars` to `fromStars + 1` (`stepDefined` false when not configured or at 6 stars). */
  evolveStep(fromStars: number): { need: number; toStars: number; currencyId: string; costPerStarUnit: number; stepDefined: boolean } {
    const evolve = this.rules.evolve();
    const from = fromStars | 0;
    const step = evolve.steps.find((entry) => (entry?.fromStars | 0) === from && (entry?.toStars | 0) === from + 1);
    return {
      need: Math.max(0, step?.requiredStarPoints ?? 0),
      toStars: from + 1,
      currencyId: evolve.currencyId || "GO",
      costPerStarUnit: Math.max(0, evolve.costPerStarUnit | 0),
      stepDefined: !!step && from >= 1 && from < 6,
    };
  }
}
