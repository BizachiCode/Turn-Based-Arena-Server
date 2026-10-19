// Builds an authoritative arena battle: both teams go through the player build pipeline of PvE
// (`buildTeamUnits`: runes, rune sets, team auras, leader skills), single wave, mode `arena`. Passive auras are
// evaluated by the battle engine.

import { ulid } from "ulid";

import { getCombatFormulaCatalog } from "../../config/CombatFormulaCatalog.js";
import type { ArenaNpcRival } from "../../config/ArenaCatalog.js";
import { ArenaBattleRuleset, createBattleState, createServerBattleEngine } from "../battle-core/index.js";
import {
  applySideBonuses,
  BattlePveSessionError,
  buildTeamUnits,
  loadTeamEntries,
  normalizeSelectedSlots,
  randomBattleSeed,
  resolveLeaderSkill,
  validateFormationSlots,
  type BattlePveSessionSources,
  type TeamBuildEntry,
} from "../battle-pve/BattlePveSessionFactory.js";
import { BattlePveSession } from "../battle-pve/BattlePveSession.js";
import type { CharacterDto } from "../roster/roster.dto.js";
import { ARENA_FRONT_SLOTS, ARENA_MAX_SLOTS, type ArenaDefense } from "./arena.domain.js";

export type ArenaDefenderSource =
  | { kind: "player"; userId: string; defense: ArenaDefense }
  | { kind: "npc"; npc: ArenaNpcRival };

export type CreateArenaSessionInput = {
  attacker: { userId: string; uidsInSlots: string[]; leaderSlotIndex: number };
  defender: ArenaDefenderSource;
  opponentId: string;
  turnLimit: number;
  requestId?: string | null;
  seed?: number;
};

/** Uids and ids of the defender's units are never sent to the attacker. */
function hideDefenderIdentity<T extends { metadata?: Record<string, unknown> }>(unit: T): T {
  const { rosterUid: _uid, equippedRuneUids: _runes, ...metadata } = unit.metadata ?? {};
  return { ...unit, metadata };
}

function npcEntries(npc: ArenaNpcRival): TeamBuildEntry[] {
  return npc.units.slice(0, ARENA_MAX_SLOTS).map((unit, slotIndex): TeamBuildEntry => {
    const rosterEntry: CharacterDto = {
      uid: `npc-${slotIndex + 1}`,
      characterId: unit.characterId,
      stars: unit.star,
      level: unit.level,
      currentExp: 0,
      awakened: unit.awakeningIndex > 0,
      awakeningIndex: unit.awakeningIndex,
      skillLevels: unit.skillLevels,
      locked: false,
      createdAtIso: null,
    };
    return { slotIndex, rosterEntry, runes: [] };
  });
}

/**
 * Defense team snapshot of a real player, taken now from his roster. Units he no longer owns are skipped
 * (`NO_DEFENSE` when none is left).
 */
async function playerDefenseEntries(sources: BattlePveSessionSources, userId: string, defense: ArenaDefense): Promise<TeamBuildEntry[]> {
  const slots = normalizeSelectedSlots(defense.uidsInSlots).filter((slot) => slot.slotIndex < ARENA_MAX_SLOTS);
  const owned = new Set((await sources.loadRoster(userId, slots.map((slot) => slot.uid))).map((entry) => entry.uid));
  const available = slots.filter((slot) => owned.has(slot.uid));
  if (available.length === 0) throw new BattlePveSessionError("NO_DEFENSE");
  return loadTeamEntries(sources, userId, available);
}

export class ArenaSessionFactory {
  constructor(private readonly sources: BattlePveSessionSources) {}

  async create(input: CreateArenaSessionInput): Promise<BattlePveSession> {
    const { attacker, defender } = input;
    const attackerSlots = validateFormationSlots(attacker.uidsInSlots, attacker.leaderSlotIndex, ARENA_MAX_SLOTS);
    const attackerEntries = await loadTeamEntries(this.sources, attacker.userId, attackerSlots);

    const defenderEntries = defender.kind === "npc"
      ? npcEntries(defender.npc)
      : await playerDefenseEntries(this.sources, defender.userId, defender.defense);
    const defenderLeaderSlot = defender.kind === "npc" ? defender.npc.leaderSlotIndex : defender.defense.leaderSlotIndex;

    const rawPlayers = buildTeamUnits(attackerEntries, {
      sideId: "players",
      unitIdPrefix: "player-",
      leaderSlotIndex: attacker.leaderSlotIndex,
      frontSlots: ARENA_FRONT_SLOTS,
    });
    const rawEnemies = buildTeamUnits(defenderEntries, {
      sideId: "enemies",
      unitIdPrefix: "enemy-",
      leaderSlotIndex: defenderLeaderSlot,
      frontSlots: ARENA_FRONT_SLOTS,
    }).map(hideDefenderIdentity);

    const enemies = applySideBonuses(rawEnemies, rawEnemies, rawPlayers, "arena");
    const players = applySideBonuses(rawPlayers, rawPlayers, rawEnemies, "arena");

    const playerLeaderSkillId = resolveLeaderSkill(rawPlayers)?.leaderSkill.id ?? null;
    const enemyLeaderSkillId = resolveLeaderSkill(rawEnemies)?.leaderSkill.id ?? null;
    const battleId = ulid();

    const state = createBattleState({
      battleId,
      mode: "arena",
      rulesetId: "arena-default",
      combatFormula: getCombatFormulaCatalog(),
      units: [...players, ...enemies],
      seed: input.seed ?? randomBattleSeed(),
      turnLimit: input.turnLimit,
      teams: [
        {
          sideId: "players",
          isPlayerControlled: true,
          metadata: { userId: attacker.userId, leaderSkillId: playerLeaderSkillId },
        },
        {
          sideId: "enemies",
          isPlayerControlled: false,
          metadata: { leaderSkillId: enemyLeaderSkillId },
        },
      ],
      metadata: {
        arena: true,
        opponentId: input.opponentId,
        requestId: input.requestId ?? null,
        playerSideId: "players",
        enemySideId: "enemies",
        currentWaveIndex: 0,
        totalWaves: 1,
        pendingEnemyWaveCount: 0,
        contentMode: "arena",
        playerLeaderSkillId,
        enemyWaveLeaderSkillIds: [enemyLeaderSkillId],
      },
    });

    return new BattlePveSession({
      state,
      pendingEnemyWaves: [],
      playerSideId: "players",
      enemySideId: "enemies",
      currentWaveIndex: 0,
      totalWaves: 1,
      engine: createServerBattleEngine(new ArenaBattleRuleset()),
    });
  }
}
