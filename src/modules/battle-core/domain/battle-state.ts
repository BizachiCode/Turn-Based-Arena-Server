import type { BattleLine, CharacterPassiveDTO, CharacterSkillDTO } from "../types/battle-data";
import type { BattleStatusState, BattleUnitStats } from "../statuses/status-models";

export const BATTLE_MODES = [
  "generic",
  "pve",
  "arena",
  "boss",
  "world-boss",
] as const;

export type BattleMode = typeof BATTLE_MODES[number];

export const BATTLE_PHASES = [
  "created",
  "waiting_for_turn",
  "awaiting_action",
  "resolving_action",
  "finished",
] as const;

export type BattlePhase = typeof BATTLE_PHASES[number];

export type BattleTeamState = {
  sideId: string;
  unitIds: string[];
  isPlayerControlled: boolean;
  metadata: Record<string, unknown>;
};

export type BattleUnitState = BattleStatusState & {
  sideId: string;
  characterId: string;
  elementId?: string | null;
  star: number;
  level: number;
  awakeningIndex: number;
  skillIds: string[];
  skills: CharacterSkillDTO[];
  passiveIds: string[];
  passives: CharacterPassiveDTO[];
  skillLevels: Record<string, number>;
  isLeader: boolean;
  isBoss: boolean;
  metadata: Record<string, unknown>;
  /** Formation line used by `allowedLine` validation (null = unknown, never restricts targeting). */
  line?: BattleLine | null;
  /**
   * Base (pre-rune) stats used by percentage stat buffs/debuffs (ATK/DEF/SPD buffs scale from base stats).
   * Falls back to `stats` when missing.
   */
  baseStats?: BattleUnitStats | null;
};

export type BattleState = {
  battleId: string;
  mode: BattleMode;
  rulesetId: string;
  phase: BattlePhase;
  turn: number;
  round: number;
  actingUnitId: string | null;
  winnerSideId: string | null;
  finishedReason: string | null;
  teams: BattleTeamState[];
  units: Record<string, BattleUnitState>;
  metadata: Record<string, unknown>;
};
