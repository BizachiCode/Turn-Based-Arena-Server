import { randomInt } from "crypto";
import { ulid } from "ulid";

import { computeCharacterStats } from "../progression/character-stat-calculator";
import { getCharacterById } from "../../config/CharacterCatalog";
import { getCombatFormulaCatalog } from "../../config/CombatFormulaCatalog";
import type { StatsDTO } from "../../config/DTO/characterCatalogDto";
import type { BattleContentMode } from "../../config/DTO/leaderSkillCatalogDto";
import { getLeaderSkillById } from "../../config/LeaderSkillCatalog";
import { getRegionById, getStageById, type StageDifficulty } from "../../config/MapCatalog";
import {
  applyLeaderSkillBonuses,
  applyAdditionalBattleStatBonuses,
  buildPlayerBattleStats,
  createEmptyBattleRuneSetEffects,
  createBattleState,
  leaderSkillAppliesToTarget,
  mergeBattleRuneSetEffects,
  resolveEffectiveSkillIds,
  type CreateBattleUnitInput,
} from "../battle-core";
import type { CharacterDto } from "../roster/roster.dto";
import type { RuneDto } from "../rune/rune.dto";
import { resolvePveEnemies } from "./BattlePveEnemyResolver";
import { BattlePveSession } from "./BattlePveSession";

/** Data sources the factory needs (injected by the composition root). */
export type BattlePveSessionSources = {
  /** Owned characters among `uids` (ownership is enforced by the query). */
  loadRoster(userId: string, uids: string[]): Promise<CharacterDto[]>;
  /** Runes equipped on the given characters. */
  loadEquippedRunes(userId: string, characterUids: string[]): Promise<RuneDto[]>;
};

export type CreateBattlePveSessionInput = {
  userId: string;
  regionId: string;
  stageId: string;
  difficulty: StageDifficulty;
  uidsInSlots: string[];
  leaderSlotIndex: number;
  requestId?: string | null;
  /** RNG seed of the battle (a random 32-bit value by default). */
  seed?: number;
  /** Turn limit (defaults to the stage's `turnLimit`, none when absent). */
  turnLimit?: number;
};

export class BattlePveSessionError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "BattlePveSessionError";
  }
}

export type SelectedSlot = { uid: string; slotIndex: number };

/** Non-empty formation slots, keeping each unit's slot index (empty slots are sent as ""). */
export function normalizeSelectedSlots(uidsInSlots: string[]): SelectedSlot[] {
  return (Array.isArray(uidsInSlots) ? uidsInSlots : [])
    .map((uid, slotIndex) => ({ uid: String(uid ?? "").trim(), slotIndex }))
    .filter((slot) => slot.uid.length > 0);
}

/**
 * Skill levels by skill id: `rawLevels[i]` belongs to skill slot `i` of the unit's effective skill list (awakening
 * replacements keep the slot, so the level carries over to the upgraded skill).
 */
function buildSkillLevelMap(characterId: string, rawLevels: number[], awakeningIndex: number): Record<string, number> {
  const character = getCharacterById(characterId);
  if (!character) return {};

  const orderedSkillIds = Array.isArray(character.skillIds) && character.skillIds.length > 0
    ? resolveEffectiveSkillIds(character, awakeningIndex)
    : (Array.isArray(character.skills) ? character.skills.map((skill) => skill.id) : []);

  const levels: Record<string, number> = {};
  orderedSkillIds.forEach((skillId, index) => {
    const raw = rawLevels[index];
    if (!Number.isFinite(raw)) return;
    levels[skillId] = Math.max(1, Math.floor(raw as number));
  });

  return levels;
}

function readStatsFromMetadata(raw: unknown): StatsDTO | null {
  if (!raw || typeof raw !== "object") return null;

  const candidate = raw as Record<string, unknown>;
  const hp = Number(candidate.hp);
  const atk = Number(candidate.atk);
  const def = Number(candidate.def);
  const spd = Number(candidate.spd);
  const sh = Number(candidate.sh);
  const cr = Number(candidate.cr);
  const cd = Number(candidate.cd);
  const res = Number(candidate.res);
  const acc = Number(candidate.acc);
  const eva = Number(candidate.eva);

  if (![hp, atk, def, spd, sh, cr, cd, res, acc, eva].every(Number.isFinite)) {
    return null;
  }

  return { hp, atk, def, spd, sh, cr, cd, res, acc, eva };
}

function readMetadataStringArray(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const raw = metadata?.[key];
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

function buildEnemyWaveInputs(
  regionId: string,
  stageId: string,
  difficulty: StageDifficulty
): CreateBattleUnitInput[][] {
  const resolved = resolvePveEnemies({ regionId, stageId, difficulty });
  if (!resolved.ok) {
    throw new BattlePveSessionError(resolved.error ?? "STAGE_NOT_FOUND");
  }

  const waves: CreateBattleUnitInput[][] = [];
  for (const wave of resolved.waves) {
    const units: CreateBattleUnitInput[] = [];

    for (const enemy of wave.enemies) {
      const character = getCharacterById(enemy.characterId);
      if (!character) {
        throw new BattlePveSessionError("CHAR_NOT_FOUND", `Enemy character not found: ${enemy.characterId}`);
      }

      units.push({
        unitId: enemy.unitId,
        sideId: "enemies",
        character,
        star: enemy.stars,
        level: enemy.level,
        awakeningIndex: enemy.awakeningIndex,
        statsOverride: enemy.stats,
        isBoss: enemy.isBoss,
        isLeader: enemy.isLeader,
        metadata: {
          waveIndex: wave.waveIndex,
          row: enemy.row,
          slotIndex: enemy.slotIndex,
        },
      });
    }

    waves.push(units);
  }

  return waves;
}

const LEADER_SKILL_SCOPES = ["Self", "AllAllies", "AllEnemies", "AllUnits"];

/** Content mode of a stage battle: the region kind (`story`, `dungeon`, `tower`). */
export function stageContentMode(regionId: string): BattleContentMode {
  return getRegionById(regionId)?.kind ?? "story";
}

/** Leader skill id of a unit: the awakening step's `rewards.leaderSkillId` overrides the character's. */
function leaderSkillIdOf(unit: CreateBattleUnitInput): string | null {
  const awakeningIndex = Math.max(0, Math.floor(unit.awakeningIndex ?? 0));
  const step = awakeningIndex > 0 ? unit.character.awakenings?.find((entry) => entry?.index === awakeningIndex) : undefined;
  const override = step?.rewards?.leaderSkillId;
  return override && override.trim().length > 0 ? override : unit.character.leaderSkillId ?? null;
}

export function resolveLeaderSkill(owners: CreateBattleUnitInput[]) {
  const leaderUnit = owners.find((entry) => entry.isLeader && !!entry.character);
  const leaderSkillId = leaderUnit ? leaderSkillIdOf(leaderUnit) : null;
  if (!leaderUnit || !leaderSkillId) return null;

  const leaderSkill = getLeaderSkillById(leaderSkillId);
  if (!leaderSkill || !LEADER_SKILL_SCOPES.includes(leaderSkill.scope)) return null;
  return { leaderUnit, leaderSkill };
}

function resolveInputBaseStats(unit: CreateBattleUnitInput): StatsDTO {
  const metadataBaseStats = readStatsFromMetadata(unit.metadata?.baseBattleStats);
  if (metadataBaseStats) return metadataBaseStats;

  if (unit.statsOverride) return unit.statsOverride;

  const computed = computeCharacterStats(
    unit.character,
    unit.star ?? unit.character.naturalStars ?? 1,
    unit.level ?? 1,
    unit.awakeningIndex ?? 0
  );

  if (!computed.ok) {
    const error = "error" in computed ? computed.error : "UNKNOWN";
    throw new BattlePveSessionError("STAT_COMPUTE_FAILED", `[battle-pve] failed to compute stats for ${unit.character.id}: ${error}`);
  }

  return computed.stats;
}

function resolveInputCurrentStats(unit: CreateBattleUnitInput): StatsDTO {
  return unit.statsOverride ?? resolveInputBaseStats(unit);
}

/**
 * Applies the leader skill of `owners` (one side's units) to every unit of `targets` it covers: the owner's
 * side for `Self`/`AllAllies`, the opposing side for `AllEnemies`, both for `AllUnits`.
 */
function applyLeaderSkill(targets: CreateBattleUnitInput[], owners: CreateBattleUnitInput[], mode: BattleContentMode): CreateBattleUnitInput[] {
  const context = resolveLeaderSkill(owners);
  if (!context) return targets;

  return targets.map((unit) => {
    if (!leaderSkillAppliesToTarget(context.leaderSkill, {
      ownerSideId: context.leaderUnit.sideId,
      targetSideId: unit.sideId,
      ownerUnitId: context.leaderUnit.unitId,
      targetUnitId: unit.unitId,
    })) {
      return unit;
    }

    const baseStats = resolveInputBaseStats(unit);
    const nextStats = applyLeaderSkillBonuses({
      baseStats,
      currentStats: resolveInputCurrentStats(unit),
      character: unit.character,
      leaderSkill: context.leaderSkill,
      mode,
    });
    const applied = readMetadataStringArray(unit.metadata, "appliedLeaderSkillIds");

    return {
      ...unit,
      statsOverride: nextStats,
      metadata: {
        ...(unit.metadata ?? {}),
        baseBattleStats: baseStats,
        appliedLeaderSkillIds: Array.from(new Set([...applied, context.leaderSkill.id])),
      },
    };
  });
}

/**
 * Leader skills applied to `targets`: the targets' own side first, then the opposing side. Passive auras are not
 * applied here: the battle engine evaluates them during the battle (`refreshPassiveAuras`).
 */
export function applySideBonuses(
  targets: CreateBattleUnitInput[],
  allies: CreateBattleUnitInput[],
  opponents: CreateBattleUnitInput[],
  mode: BattleContentMode
): CreateBattleUnitInput[] {
  const units = applyLeaderSkill(targets, allies, mode);
  return applyLeaderSkill(units, opponents, mode);
}

/** A random 32-bit battle seed (the engine RNG is deterministic for a given seed). */
export function randomBattleSeed(): number {
  return randomInt(1, 0x7fffffff);
}

/**
 * Non-empty formation slots of a player team, validated against the formation size
 * (`NO_UNITS`, `FORMATION_TOO_LARGE`, `INVALID_LEADER_SLOT`, `DUPLICATE_UNITS`).
 */
export function validateFormationSlots(uidsInSlots: string[], leaderSlotIndex: number, maxSlots: number): SelectedSlot[] {
  const slots = normalizeSelectedSlots(uidsInSlots);
  if (slots.length === 0) throw new BattlePveSessionError("NO_UNITS");
  if (slots.length > maxSlots || slots.some((slot) => slot.slotIndex >= maxSlots)) {
    throw new BattlePveSessionError("FORMATION_TOO_LARGE");
  }
  if (leaderSlotIndex < 0 || leaderSlotIndex >= maxSlots) {
    throw new BattlePveSessionError("INVALID_LEADER_SLOT");
  }
  const uids = slots.map((slot) => slot.uid);
  if (new Set(uids).size !== uids.length) {
    throw new BattlePveSessionError("DUPLICATE_UNITS");
  }
  return slots;
}

/** One unit of a team about to be built: roster data, formation slot and equipped runes. */
export type TeamBuildEntry = { slotIndex: number; rosterEntry: CharacterDto; runes: RuneDto[] };

/** Loads the units of `slots` owned by `userId` with their equipped runes (`UNIT_NOT_OWNED` when one is missing). */
export async function loadTeamEntries(sources: BattlePveSessionSources, userId: string, slots: SelectedSlot[]): Promise<TeamBuildEntry[]> {
  const selectedUids = slots.map((slot) => slot.uid);
  const rosterEntries = await sources.loadRoster(userId, selectedUids);
  const rosterByUid = new Map(rosterEntries.map((entry) => [entry.uid, entry]));
  if (rosterByUid.size !== selectedUids.length) {
    throw new BattlePveSessionError("UNIT_NOT_OWNED");
  }

  const equippedRunesByUid = new Map<string, RuneDto[]>();
  for (const rune of await sources.loadEquippedRunes(userId, selectedUids)) {
    if (!rune.equippedToUid) continue;
    const current = equippedRunesByUid.get(rune.equippedToUid) ?? [];
    current.push(rune);
    equippedRunesByUid.set(rune.equippedToUid, current);
  }

  return slots.map((slot) => {
    const rosterEntry = rosterByUid.get(slot.uid);
    if (!rosterEntry) throw new BattlePveSessionError("UNIT_NOT_OWNED");
    return { slotIndex: slot.slotIndex, rosterEntry, runes: equippedRunesByUid.get(slot.uid) ?? [] };
  });
}

/**
 * The player build pipeline for one team: stats from the roster entry + equipped runes + rune sets + the team's
 * shared auras. Used for the player's units in PvE and for both teams of an arena battle.
 */
export function buildTeamUnits(
  entries: TeamBuildEntry[],
  options: { sideId: string; unitIdPrefix: string; leaderSlotIndex: number; frontSlots: number },
): CreateBattleUnitInput[] {
  const sharedTeamAuraBonuses: StatsDTO = { hp: 0, atk: 0, def: 0, spd: 0, sh: 0, cr: 0, cd: 0, res: 0, acc: 0, eva: 0 };
  let sharedTeamAuraSetEffects = createEmptyBattleRuneSetEffects();

  const playerBuildEntries = entries.map((entry, index) => {
    const { rosterEntry } = entry;
    const character = getCharacterById(rosterEntry.characterId);
    if (!character) {
      throw new BattlePveSessionError("CHAR_NOT_FOUND", `Player character not found: ${rosterEntry.characterId}`);
    }

    const playerBuild = buildPlayerBattleStats({
      character,
      star: rosterEntry.stars,
      level: rosterEntry.level,
      awakeningIndex: rosterEntry.awakeningIndex,
      equippedRunes: entry.runes,
    });

    for (const key of Object.keys(sharedTeamAuraBonuses) as Array<keyof StatsDTO>) {
      sharedTeamAuraBonuses[key] += playerBuild.teamAuraBonuses[key];
    }
    sharedTeamAuraSetEffects = mergeBattleRuneSetEffects(sharedTeamAuraSetEffects, playerBuild.teamAuraSetEffects);

    return { index, slotIndex: entry.slotIndex, rosterEntry, character, playerBuild };
  });

  return playerBuildEntries.map((entry) => ({
    unitId: `${options.unitIdPrefix}${entry.index + 1}`,
    sideId: options.sideId,
    character: entry.character,
    star: entry.rosterEntry.stars,
    level: entry.rosterEntry.level,
    awakeningIndex: entry.rosterEntry.awakeningIndex,
    statsOverride: applyAdditionalBattleStatBonuses(
      entry.playerBuild.baseStats,
      entry.playerBuild.finalStats,
      sharedTeamAuraBonuses
    ),
    skillLevels: buildSkillLevelMap(entry.rosterEntry.characterId, entry.rosterEntry.skillLevels, entry.rosterEntry.awakeningIndex),
    isLeader: entry.slotIndex === options.leaderSlotIndex,
    metadata: {
      baseBattleStats: entry.playerBuild.baseStats,
      rosterUid: entry.rosterEntry.uid,
      slotIndex: entry.slotIndex,
      row: entry.slotIndex < options.frontSlots ? "Frontline" : "Backline",
      equippedRuneUids: entry.playerBuild.equippedRunes.map((rune) => rune.uid),
      completedRuneSets: entry.playerBuild.completedSets,
      runeSetEffects: mergeBattleRuneSetEffects(entry.playerBuild.setEffects, sharedTeamAuraSetEffects),
    },
  }));
}

/** Builds authoritative PvE battle sessions from the player's roster/runes and the stage definition. */
export class BattlePveSessionFactory {
  constructor(private readonly sources: BattlePveSessionSources) {}

  create(input: CreateBattlePveSessionInput): Promise<BattlePveSession> {
    return createBattlePveSession(input, this.sources);
  }
}

export async function createBattlePveSession(input: CreateBattlePveSessionInput, sources: BattlePveSessionSources): Promise<BattlePveSession> {
  const stage = getStageById(input.regionId, input.stageId);
  if (!stage) {
    throw new BattlePveSessionError("STAGE_NOT_FOUND");
  }

  const frontSlots = Math.max(0, stage.formation?.front ?? 0);
  const maxSlots = Math.max(0, frontSlots + (stage.formation?.back ?? 0));
  if (maxSlots <= 0) throw new BattlePveSessionError("INVALID_STAGE_FORMATION");
  const slots = validateFormationSlots(input.uidsInSlots, input.leaderSlotIndex, maxSlots);

  const playerUnits = buildTeamUnits(await loadTeamEntries(sources, input.userId, slots), {
    sideId: "players",
    unitIdPrefix: "player-",
    leaderSlotIndex: input.leaderSlotIndex,
    frontSlots,
  });

  const rawEnemyWaves = buildEnemyWaveInputs(input.regionId, input.stageId, input.difficulty);
  if (rawEnemyWaves.length === 0) {
    throw new BattlePveSessionError("NO_ENEMY_WAVES");
  }

  // Leader skills are fixed when the session is created: the player leader reaches every enemy wave, while an enemy
  // leader that targets the player side comes from the first wave (the one present when the battle starts).
  const mode = stageContentMode(input.regionId);
  const enemyWaves = rawEnemyWaves.map((wave) => applySideBonuses(wave, wave, playerUnits, mode));
  const playerUnitsWithBonuses = applySideBonuses(playerUnits, playerUnits, rawEnemyWaves[0], mode);

  const playerLeaderSkillId = resolveLeaderSkill(playerUnits)?.leaderSkill.id ?? null;
  const enemyWaveLeaderSkillIds = rawEnemyWaves.map((wave) => resolveLeaderSkill(wave)?.leaderSkill.id ?? null);

  const [firstWave, ...pendingEnemyWaves] = enemyWaves;
  const battleId = ulid();
  const turnLimit = input.turnLimit ?? stage.turnLimit;

  const initialState = createBattleState({
    battleId,
    mode: "pve",
    rulesetId: "pve-default",
    combatFormula: getCombatFormulaCatalog(),
    units: [...playerUnitsWithBonuses, ...firstWave],
    seed: input.seed ?? randomBattleSeed(),
    ...(turnLimit && turnLimit > 0 ? { turnLimit } : {}),
    teams: [
      {
        sideId: "players",
        isPlayerControlled: true,
        metadata: {
          userId: input.userId,
          leaderSkillId: playerLeaderSkillId,
        },
      },
      {
        sideId: "enemies",
        isPlayerControlled: false,
        metadata: {
          regionId: input.regionId,
          stageId: input.stageId,
          difficulty: input.difficulty,
          leaderSkillId: enemyWaveLeaderSkillIds[0],
        },
      },
    ],
    metadata: {
      regionId: input.regionId,
      stageId: input.stageId,
      difficulty: input.difficulty,
      requestId: input.requestId ?? null,
      playerSideId: "players",
      enemySideId: "enemies",
      currentWaveIndex: 0,
      totalWaves: enemyWaves.length,
      pendingEnemyWaveCount: pendingEnemyWaves.length,
      contentMode: mode,
      playerLeaderSkillId,
      enemyWaveLeaderSkillIds,
    },
  });

  return new BattlePveSession({
    state: initialState,
    pendingEnemyWaves,
    playerSideId: "players",
    enemySideId: "enemies",
    currentWaveIndex: 0,
    totalWaves: enemyWaves.length,
  });
}
