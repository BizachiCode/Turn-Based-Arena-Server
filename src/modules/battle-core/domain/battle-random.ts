/** Deterministic random source used by the battle engine. `next()` returns a double in [0, 1). */
export interface BattleRandom {
  next(): number;
  snapshot(): { seed: number; state: number };
}

/**
 * FNV-1a 32-bit hash for string seeds; finite numbers are converted with ToUint32 (`seed >>> 0`).
 * The C# port (`BattleRandomSeed.Hash`) produces bit-identical results.
 */
export function hashBattleSeed(seed: number | string | null | undefined): number {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0;
  }

  const text = String(seed ?? "0");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

/** xorshift32 generator. `next()` = state / 2^32 after one xorshift step. */
export class SeededBattleRandom implements BattleRandom {
  private readonly seed: number;
  private state: number;

  constructor(seed: number | string, state?: number) {
    this.seed = hashBattleSeed(seed);
    this.state = typeof state === "number" && Number.isFinite(state) ? (state >>> 0) : this.seed;
    if (this.state === 0) this.state = 1;
  }

  next(): number {
    let x = this.state || 1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }

  snapshot(): { seed: number; state: number } {
    return { seed: this.seed, state: this.state };
  }
}

/** Metadata key holding the battle seed (number or string). */
export const BATTLE_SEED_METADATA_KEY = "seed";
/** Metadata key holding the current xorshift32 state, persisted after every engine dispatch. */
export const BATTLE_RNG_STATE_METADATA_KEY = "rngState";

/**
 * Restores the battle RNG from `state.metadata` (`rngState`, falling back to `seed`, then to the battle id).
 * This makes every dispatch a pure function of (state, command) so battles can be replayed.
 */
export function createBattleRandomFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  fallbackSeed: string
): SeededBattleRandom {
  const seedRaw = metadata?.[BATTLE_SEED_METADATA_KEY];
  const seed = typeof seedRaw === "number" || typeof seedRaw === "string" ? seedRaw : fallbackSeed;
  const stateRaw = metadata?.[BATTLE_RNG_STATE_METADATA_KEY];
  return new SeededBattleRandom(seed, typeof stateRaw === "number" ? stateRaw : undefined);
}
