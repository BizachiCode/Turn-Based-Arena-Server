// Arena constants, shared types and the pure opponent selection (see docs/ARENA.md "Rules").

import type { RandomSource } from "../../shared/kernel/random.js";

/**
 * Rechargeable currency spent per attack (max / interval configured in `currencies.json`, cost per attack in
 * `arena.json` `wingCost`).
 */
export const ARENA_WING_CURRENCY = "AW";

/** Team size of arena and friendly battles (the formation screens are built for 4 slots). */
export const ARENA_MAX_SLOTS = 4;
/** Slots below this index stand in the front line, the others in the back line. */
export const ARENA_FRONT_SLOTS = 2;

export type ArenaDefense = { uidsInSlots: string[]; leaderSlotIndex: number };

/** Unit as shown in the opponent list (no uids, no rune details). */
export type ArenaUnitView = { characterId: string; star: number; level: number; element: string };

/** Opponent as offered to (and cached for) the attacker. `opponentId` is `u:<publicId>` or `npc:<id>`. */
export type ArenaOpponentView = { opponentId: string; name: string; rating: number; level: number; units: ArenaUnitView[] };

export type ParsedOpponentId = { kind: "player"; publicId: string } | { kind: "npc"; npcId: string };

/** Parses `u:<publicId>` / `npc:<id>` (null when malformed). */
export function parseOpponentId(raw: string): ParsedOpponentId | null {
  const match = /^(u|npc):([A-Za-z0-9_-]{1,64})$/.exec(raw);
  if (!match) return null;
  return match[1] === "u" ? { kind: "player", publicId: match[2] } : { kind: "npc", npcId: match[2] };
}

export const playerOpponentId = (publicId: string) => `u:${publicId}`;
export const npcOpponentId = (npcId: string) => `npc:${npcId}`;

export type OpponentPick<TPlayer, TNpc> = { kind: "player"; player: TPlayer } | { kind: "npc"; npc: TNpc };

export type SelectOpponentsInput<TPlayer extends { userId: string; rating: number }, TNpc extends { id: string; rating: number }> = {
  /** Rating of the attacker. */
  rating: number;
  /** Real players that have a defense team. */
  players: readonly TPlayer[];
  npcs: readonly TNpc[];
  /** User ids that must not be offered (the attacker himself, players attacked recently). */
  excludeUserIds: ReadonlySet<string>;
  random: RandomSource;
  /** Opponents to pick (`arena.json` `opponentCount`). */
  count: number;
  /** Rating distances tried in order, ascending (`arena.json` `ratingWindows`). */
  windows: readonly number[];
};

function shuffle<T>(items: T[], random: RandomSource): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = random.int(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Picks up to `count` opponents: real players within the first rating window (random order), widening window by
 * window and then to any rating (closest first), and fills what is left with the NPC rivals closest in rating. The
 * result is sorted by rating (ascending).
 */
export function selectOpponents<TPlayer extends { userId: string; rating: number }, TNpc extends { id: string; rating: number }>(
  input: SelectOpponentsInput<TPlayer, TNpc>,
): Array<OpponentPick<TPlayer, TNpc>> {
  const count = input.count;
  const distance = (rating: number) => Math.abs(rating - input.rating);
  const pool = input.players.filter((player) => !input.excludeUserIds.has(player.userId));
  const picked: TPlayer[] = [];

  const windows = [...input.windows, Number.POSITIVE_INFINITY];
  for (const window of windows) {
    if (picked.length >= count) break;
    const tier = pool.filter((player) => !picked.includes(player) && distance(player.rating) <= window);
    const ordered = window === Number.POSITIVE_INFINITY
      ? tier.sort((a, b) => distance(a.rating) - distance(b.rating))
      : shuffle(tier, input.random);
    for (const player of ordered) {
      if (picked.length >= count) break;
      picked.push(player);
    }
  }

  const npcs = [...input.npcs]
    .sort((a, b) => distance(a.rating) - distance(b.rating) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, count - picked.length));

  const picks: Array<OpponentPick<TPlayer, TNpc>> = [
    ...picked.map((player) => ({ kind: "player" as const, player })),
    ...npcs.map((npc) => ({ kind: "npc" as const, npc })),
  ];
  const ratingOf = (pick: OpponentPick<TPlayer, TNpc>) => (pick.kind === "player" ? pick.player.rating : pick.npc.rating);
  return picks.sort((a, b) => ratingOf(a) - ratingOf(b));
}
