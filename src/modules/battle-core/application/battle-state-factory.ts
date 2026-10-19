import type { AwakeningReplacementDTO, CharacterDTO, StatsDTO } from "../../../config/DTO/characterCatalogDto";
import { computeCharacterStats } from "../../progression/character-stat-calculator";
import {
  CombatFormulaSnapshot,
  createDefaultCombatFormulaSnapshot,
} from "../domain/combat-formula";
import type { BattleMode, BattleState, BattleTeamState, BattleUnitState } from "../domain/battle-state";
import type { BattleLine, CharacterPassiveDTO, CharacterSkillDTO } from "../types/battle-data";
import { normalizeBattleLine } from "../types/battle-data";
import type { BattleUnitStats } from "../statuses/status-models";

export type CreateBattleUnitInput = {
  unitId: string;
  sideId: string;
  character: CharacterDTO;
  star?: number;
  level?: number;
  awakeningIndex?: number;
  statsOverride?: StatsDTO;
  isLeader?: boolean;
  isBoss?: boolean;
  skillLevels?: Record<string, number>;
  turnBar?: number;
  metadata?: Record<string, unknown>;
  skills?: CharacterSkillDTO[];
  passives?: CharacterPassiveDTO[];
  /** Formation line (falls back to `metadata.row`). */
  line?: BattleLine | null;
  /** Base (pre-rune) stats used by stat buffs (falls back to `metadata.baseBattleStats`, then the final stats). */
  baseStats?: StatsDTO | null;
};

export type CreateBattleStateInput = {
  battleId: string;
  mode: BattleMode;
  rulesetId: string;
  combatFormula?: CombatFormulaSnapshot;
  units: CreateBattleUnitInput[];
  teams?: Array<{
    sideId: string;
    isPlayerControlled?: boolean;
    metadata?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
  /** RNG seed stored in `metadata.seed` (defaults to the battle id). */
  seed?: number | string;
  /** Optional turn limit stored in `metadata.turnLimit` (draw when reached). */
  turnLimit?: number;
};

function readStatsLike(raw: unknown): StatsDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const keys = ["hp", "atk", "def", "spd", "sh", "cr", "cd", "res", "acc", "eva"] as const;
  for (const key of keys) {
    if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key] as number)) return null;
  }
  return candidate as unknown as StatsDTO;
}

function mapStatsToUnitStats(stats: StatsDTO): BattleUnitStats {
  return {
    atk: stats.atk,
    def: stats.def,
    spd: stats.spd,
    cr: stats.cr,
    cd: stats.cd,
    res: stats.res,
    acc: stats.acc,
    eva: stats.eva,
  };
}

/**
 * Effective ids for an awakening: the base ids with the awakening step's replacements applied in place (the slot is
 * kept), then its additions appended; duplicates removed (first wins).
 */
function resolveAwakenedIds(
  baseIds: string[] | undefined,
  replacements: AwakeningReplacementDTO[] | undefined,
  additions: string[] | undefined
): string[] {
  const ids = Array.isArray(baseIds) ? [...baseIds] : [];
  for (const replacement of Array.isArray(replacements) ? replacements : []) {
    const index = ids.indexOf(replacement.from);
    if (index >= 0 && replacement.to) ids[index] = replacement.to;
  }
  return Array.from(new Set([...ids, ...(Array.isArray(additions) ? additions : [])]));
}

function findAwakeningStep(character: CharacterDTO, awakeningIndex: number) {
  if (awakeningIndex <= 0 || !Array.isArray(character.awakenings)) return undefined;
  return character.awakenings.find((entry) => entry && entry.index === awakeningIndex);
}

/** Skill ids of a character at an awakening (slot order: replaced skills keep their slot, added skills last). */
export function resolveEffectiveSkillIds(character: CharacterDTO, awakeningIndex: number): string[] {
  const rewards = findAwakeningStep(character, awakeningIndex)?.rewards;
  return resolveAwakenedIds(character.skillIds, rewards?.replaceSkills, rewards?.addSkillIds);
}

/** Passive ids of a character at an awakening (replacements in place, additions last). */
export function resolveEffectivePassiveIds(character: CharacterDTO, awakeningIndex: number): string[] {
  const rewards = findAwakeningStep(character, awakeningIndex)?.rewards;
  return resolveAwakenedIds(character.passiveIds, rewards?.replacePassives, rewards?.addPassiveIds);
}

export function resolveEffectiveSkills(
  character: CharacterDTO,
  awakeningIndex: number,
  overrideSkills?: CharacterSkillDTO[]
): CharacterSkillDTO[] {
  const candidateSkills = Array.isArray(overrideSkills) && overrideSkills.length > 0
    ? overrideSkills
    : (Array.isArray(character.skills) ? character.skills : []);

  if (candidateSkills.length === 0) return [];

  const effectiveIds = resolveEffectiveSkillIds(character, awakeningIndex);
  if (effectiveIds.length === 0) return [...candidateSkills];

  return effectiveIds
    .map((id) => candidateSkills.find((skill) => skill.id === id))
    .filter((skill): skill is CharacterSkillDTO => !!skill);
}

export function resolveEffectivePassives(
  character: CharacterDTO,
  awakeningIndex: number,
  overridePassives?: CharacterPassiveDTO[]
): CharacterPassiveDTO[] {
  const candidatePassives = Array.isArray(overridePassives) && overridePassives.length > 0
    ? overridePassives
    : (Array.isArray(character.passives) ? character.passives : []);

  if (candidatePassives.length === 0) return [];

  const effectiveIds = resolveEffectivePassiveIds(character, awakeningIndex);
  if (effectiveIds.length === 0) return [...candidatePassives];

  return effectiveIds
    .map((id) => candidatePassives.find((passive) => passive.id === id))
    .filter((passive): passive is CharacterPassiveDTO => !!passive);
}

function sanitizeSkillLevels(skills: CharacterSkillDTO[], skillLevels?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const skill of skills) {
    const raw = skillLevels?.[skill.id];
    out[skill.id] = Number.isFinite(raw) ? Math.max(1, Math.floor(raw as number)) : 1;
  }
  return out;
}

export function createBattleUnitState(input: CreateBattleUnitInput): BattleUnitState {
  const star = Math.max(1, Math.min(6, Math.floor(input.star ?? input.character.naturalStars ?? 1)));
  const level = Math.max(1, Math.floor(input.level ?? 1));
  const awakeningIndex = Math.max(0, Math.floor(input.awakeningIndex ?? 0));

  let resolvedStats: StatsDTO | null = input.statsOverride ?? null;
  if (!resolvedStats) {
    const computed = computeCharacterStats(input.character, star, level, awakeningIndex);
    if (!computed.ok) {
      const error = "error" in computed ? computed.error : "UNKNOWN";
      throw new Error(`[battle-core] unable to compute stats for character=${input.character.id}: ${error}`);
    }

    resolvedStats = computed.stats;
  }

  const stats = mapStatsToUnitStats(resolvedStats);
  const baseSource = input.baseStats ?? readStatsLike(input.metadata?.baseBattleStats);
  const baseStats = baseSource ? mapStatsToUnitStats(baseSource) : { ...stats };
  const line = normalizeBattleLine(input.line) ?? normalizeBattleLine(input.metadata?.row) ?? null;
  const skills = resolveEffectiveSkills(input.character, awakeningIndex, input.skills);
  const skillIds = resolveEffectiveSkillIds(input.character, awakeningIndex);
  const passives = resolveEffectivePassives(input.character, awakeningIndex, input.passives);
  const passiveIds = resolveEffectivePassiveIds(input.character, awakeningIndex);
  const skillLevels = sanitizeSkillLevels(skills, input.skillLevels);

  return {
    unitId: input.unitId,
    sideId: input.sideId,
    characterId: input.character.id,
    elementId: input.character.element ?? null,
    star,
    level,
    awakeningIndex,
    currentHp: Math.max(1, Math.round(resolvedStats.hp)),
    maxHp: Math.max(1, Math.round(resolvedStats.hp)),
    shield: Math.max(0, Math.round(resolvedStats.sh)),
    turnBar: Number.isFinite(input.turnBar) ? Math.max(0, input.turnBar as number) : 0,
    turnThreshold: 1000,
    cooldowns: {},
    statuses: [],
    stats,
    skillIds,
    skills,
    passiveIds,
    passives,
    skillLevels,
    isLeader: !!input.isLeader,
    isBoss: !!input.isBoss,
    metadata: { ...(input.metadata ?? {}) },
    line,
    baseStats,
  };
}

export function createBattleState(input: CreateBattleStateInput): BattleState {
  const formulas = input.combatFormula ?? createDefaultCombatFormulaSnapshot();
  const units: Record<string, BattleUnitState> = {};
  for (const unitInput of input.units) {
    units[unitInput.unitId] = createBattleUnitState(unitInput);
    units[unitInput.unitId].turnThreshold = formulas.timing.defaultTurnThreshold;
    units[unitInput.unitId].turnBar = Math.max(
      0,
      Math.min(
        units[unitInput.unitId].turnThreshold * formulas.timing.turnBarHeadroomMultiplier,
        units[unitInput.unitId].turnBar
      )
    );
  }

  const inferredTeams = new Map<string, BattleTeamState>();
  for (const unit of Object.values(units)) {
    const current = inferredTeams.get(unit.sideId) ?? {
      sideId: unit.sideId,
      unitIds: [],
      isPlayerControlled: false,
      metadata: {},
    };
    current.unitIds.push(unit.unitId);
    inferredTeams.set(unit.sideId, current);
  }

  const explicitTeams = Array.isArray(input.teams) ? input.teams : [];
  for (const team of explicitTeams) {
    const current = inferredTeams.get(team.sideId) ?? {
      sideId: team.sideId,
      unitIds: [],
      isPlayerControlled: false,
      metadata: {},
    };
    current.isPlayerControlled = !!team.isPlayerControlled;
    current.metadata = { ...current.metadata, ...(team.metadata ?? {}) };
    inferredTeams.set(team.sideId, current);
  }

  return {
    battleId: input.battleId,
    mode: input.mode,
    rulesetId: input.rulesetId,
    phase: "created",
    turn: 0,
    round: 1,
    actingUnitId: null,
    winnerSideId: null,
    finishedReason: null,
    teams: Array.from(inferredTeams.values()),
    units,
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.turnLimit !== undefined ? { turnLimit: input.turnLimit } : {}),
      seed: input.seed ?? (input.metadata?.seed as number | string | undefined) ?? input.battleId,
    },
  };
}
