// Pure Elo rating math of the arena (mirrored by the Unity offline backend, see docs/ARENA.md).

/** Probability (0..1) that a player rated `own` beats a player rated `opponent`. */
export function expectedScore(own: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - own) / 400));
}

/**
 * Raw Elo change of the player rated `own` (positive on a win, negative on a loss), rounded like JS `Math.round`
 * (half rounds up): `round(k * (score - expected))`.
 */
export function eloDelta(own: number, opponent: number, won: boolean, kFactor: number): number {
  const delta = Math.round(kFactor * ((won ? 1 : 0) - expectedScore(own, opponent)));
  return delta === 0 ? 0 : delta; // never -0
}

export type ArenaRatingInput = {
  attackerRating: number;
  defenderRating: number;
  attackerWon: boolean;
  kFactor: number;
  /** NPC rivals have a fixed rating: only the attacker changes. */
  defenderIsNpc?: boolean;
  /** Ratings never drop below this value (default 0). */
  floor?: number;
};

export type ArenaRatingResult = {
  attackerAfter: number;
  /** Applied attacker change (after the floor). */
  attackerDelta: number;
  defenderAfter: number;
  /** Applied defender change: the mirror of the attacker's raw change, clamped at the floor. */
  defenderDelta: number;
};

/** Rating changes of one arena battle: the attacker gets `delta`, a real defender gets `-delta`, both clamped. */
export function resolveArenaRatings(input: ArenaRatingInput): ArenaRatingResult {
  const floor = input.floor ?? 0;
  const raw = eloDelta(input.attackerRating, input.defenderRating, input.attackerWon, input.kFactor);

  const attackerAfter = Math.max(floor, input.attackerRating + raw);
  const defenderAfter = input.defenderIsNpc ? input.defenderRating : Math.max(floor, input.defenderRating - raw);

  return {
    attackerAfter,
    attackerDelta: attackerAfter - input.attackerRating,
    defenderAfter,
    defenderDelta: defenderAfter - input.defenderRating,
  };
}
