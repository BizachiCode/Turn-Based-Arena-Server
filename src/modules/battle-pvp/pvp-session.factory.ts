// Builds a real-time PvP battle: both teams go through the player build pipeline of PvE / arena (`buildTeamUnits`:
// runes, rune sets, team auras, leader skills), single wave. Leader skills use the `arena` content mode (a leader
// `modeFilter: arena` applies to friendly battles too). Passive auras are evaluated by the engine.

import { ulid } from "ulid";

import { getCombatFormulaCatalog } from "../../config/CombatFormulaCatalog.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ArenaBattleRuleset, createBattleState, createServerBattleEngine } from "../battle-core/index.js";
import {
  applySideBonuses,
  BattlePveSessionError,
  buildTeamUnits,
  loadTeamEntries,
  randomBattleSeed,
  resolveLeaderSkill,
  validateFormationSlots,
  type BattlePveSessionSources,
} from "../battle-pve/BattlePveSessionFactory.js";
import { ARENA_FRONT_SLOTS, ARENA_MAX_SLOTS } from "../arena/arena.domain.js";
import { PvpBattleSession } from "./pvp-battle-session.js";

/** Side ids of a PvP battle: `side_a` = the challenger, `side_b` = the challenged player. */
export const PVP_SIDE_A = "side_a";
export const PVP_SIDE_B = "side_b";

export type PvpTeam = { userId: string; uidsInSlots: string[]; leaderSlotIndex: number };

export type CreatePvpSessionInput = {
  matchId: string;
  sideA: PvpTeam;
  sideB: PvpTeam;
  turnLimit: number;
  seed?: number;
};

function asAppError(error: unknown): unknown {
  return error instanceof BattlePveSessionError ? new AppError(error.code, { message: error.message }) : error;
}

export class PvpSessionFactory {
  constructor(private readonly sources: BattlePveSessionSources) {}

  /** Validates a team the player locks in (formation size, leader slot, ownership): throws the PvE formation errors. */
  async validateTeam(team: PvpTeam): Promise<void> {
    try {
      const slots = validateFormationSlots(team.uidsInSlots, team.leaderSlotIndex, ARENA_MAX_SLOTS);
      await loadTeamEntries(this.sources, team.userId, slots);
    } catch (error) {
      throw asAppError(error);
    }
  }

  async create(input: CreatePvpSessionInput): Promise<PvpBattleSession> {
    try {
      const [entriesA, entriesB] = await Promise.all([input.sideA, input.sideB].map((team) =>
        loadTeamEntries(this.sources, team.userId, validateFormationSlots(team.uidsInSlots, team.leaderSlotIndex, ARENA_MAX_SLOTS))));
      const rawA = buildTeamUnits(entriesA, { sideId: PVP_SIDE_A, unitIdPrefix: "a-", leaderSlotIndex: input.sideA.leaderSlotIndex, frontSlots: ARENA_FRONT_SLOTS });
      const rawB = buildTeamUnits(entriesB, { sideId: PVP_SIDE_B, unitIdPrefix: "b-", leaderSlotIndex: input.sideB.leaderSlotIndex, frontSlots: ARENA_FRONT_SLOTS });
      const unitsA = applySideBonuses(rawA, rawA, rawB, "arena");
      const unitsB = applySideBonuses(rawB, rawB, rawA, "arena");
      const leaderA = resolveLeaderSkill(rawA)?.leaderSkill.id ?? null;
      const leaderB = resolveLeaderSkill(rawB)?.leaderSkill.id ?? null;

      const state = createBattleState({
        battleId: ulid(),
        mode: "arena",
        rulesetId: "arena-default",
        combatFormula: getCombatFormulaCatalog(),
        units: [...unitsA, ...unitsB],
        seed: input.seed ?? randomBattleSeed(),
        turnLimit: input.turnLimit,
        teams: [
          { sideId: PVP_SIDE_A, isPlayerControlled: true, metadata: { userId: input.sideA.userId, leaderSkillId: leaderA } },
          { sideId: PVP_SIDE_B, isPlayerControlled: true, metadata: { userId: input.sideB.userId, leaderSkillId: leaderB } },
        ],
        metadata: {
          pvp: true,
          friendly: true,
          matchId: input.matchId,
          contentMode: "arena",
          currentWaveIndex: 0,
          totalWaves: 1,
          pendingEnemyWaveCount: 0,
        },
      });

      return new PvpBattleSession({
        state,
        engine: createServerBattleEngine(new ArenaBattleRuleset()),
        sideIds: [PVP_SIDE_A, PVP_SIDE_B],
      });
    } catch (error) {
      throw asAppError(error);
    }
  }
}
