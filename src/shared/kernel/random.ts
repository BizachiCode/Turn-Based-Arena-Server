import crypto from "node:crypto";

/**
 * Randomness abstraction (gameplay rolls, drops, gacha). Production uses a CSPRNG;
 * tests inject a seeded or scripted source.
 */
export interface RandomSource {
  /** Uniform integer in [0, maxExclusive). Returns 0 when maxExclusive <= 1. */
  int(maxExclusive: number): number;
  /** Uniform float in [0, 1). */
  float(): number;
}

export const cryptoRandom: RandomSource = {
  int: (maxExclusive) => (maxExclusive <= 1 ? 0 : crypto.randomInt(0, Math.floor(maxExclusive))),
  float: () => crypto.randomInt(0, 0x1000000) / 0x1000000,
};

/** Deterministic xorshift32 source (tests, simulations). */
export function createSeededRandom(seed: number): RandomSource {
  let state = (seed | 0) || 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };

  return {
    int: (maxExclusive) => (maxExclusive <= 1 ? 0 : Math.floor(next() * Math.floor(maxExclusive))),
    float: next,
  };
}

/** Picks a random element; throws on an empty list. */
export function pickOne<T>(random: RandomSource, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pickOne: empty list");
  return items[random.int(items.length)];
}

/** Weighted pick (weights <= 0 are ignored); throws when no positive weight exists. */
export function pickWeighted<T extends { weight: number }>(random: RandomSource, items: readonly T[]): T {
  const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
  if (total <= 0) throw new Error("INVALID_WEIGHT_LIST");

  let roll = random.float() * total;
  for (const item of items) {
    const weight = Math.max(0, Number(item.weight) || 0);
    if (roll < weight) return item;
    roll -= weight;
  }

  return items[items.length - 1];
}
