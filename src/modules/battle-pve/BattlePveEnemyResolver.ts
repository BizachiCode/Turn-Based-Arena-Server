import { getDifficultyScalingFor, getStageById } from "../../config/MapCatalog";
import { getCharacterById } from "../../config/CharacterCatalog";
import { computeCharacterStats, maxLevelAtStar } from "../progression/character-stat-calculator";
import { StatsDTO } from "../../config/DTO/characterCatalogDto";

export type BattlePveGetEnemiesRequest = {
  regionId: string;
  stageId: string;
  difficulty: "Easy" | "Normal" | "Hard" | "Hell";
};

export type BattleFormationDTO = {
  front: number;
  back: number;
  leaderIndex: number;
};

export type BattlePveEnemyDTO = {
  unitId: string;
  characterId: string;
  stars: number;
  level: number;
  awakeningIndex: number;
  isBoss: boolean;
  isLeader: boolean;
  row: "Frontline" | "Backline";
  slotIndex: number;
  stats: StatsDTO;
};

export type BattlePveWaveDTO = {
  waveIndex: number;
  formation: BattleFormationDTO;
  enemies: BattlePveEnemyDTO[];
};

export type BattlePveGetEnemiesResponse = {
  ok: boolean;
  error?: string;
  regionId: string;
  stageId: string;
  formation: BattleFormationDTO;

  /** Enemy waves, fought in order. */
  waves: BattlePveWaveDTO[];
};

function clampInt(v: any, min: number, max: number): number {
  const n = Number(v) | 0;
  return Math.max(min, Math.min(max, n));
}

function buildStatsDTOFromMap(e: any): StatsDTO | null {
  const s = e?.stats;
  if (!s || typeof s !== "object") return null;

  const maxHp = Math.max(1, Number(s.maxHp ?? 0) | 0);
  if (maxHp <= 0) return null;

  const stats: StatsDTO = {
  hp: maxHp,
  atk: Math.max(0, Number(s.attack ?? 0) | 0),
  def: Math.max(0, Number(s.defense ?? 0) | 0),
  spd: Math.max(0, Number(s.speed ?? 0) | 0),

  sh: 0, 
  cr: s.critRate != null ? Number(s.critRate) : 0,
  cd: s.critDamage != null ? Number(s.critDamage) : 0,
  res: s.resistance != null ? Number(s.resistance) : 0,
  acc: s.accuracy != null ? Number(s.accuracy) : 0,
  eva: 0, // evasion (default)
};

return stats;
}

export function resolvePveEnemies(req: BattlePveGetEnemiesRequest): BattlePveGetEnemiesResponse {
  const regionId = String(req?.regionId ?? "");
  const stageId = String(req?.stageId ?? "");

  const stage = getStageById(regionId, stageId);
  if (!stage) {
    return {
      ok: false,
      error: "STAGE_NOT_FOUND",
      regionId,
      stageId,
      formation: { front: 0, back: 0, leaderIndex: 0 },
      waves: [],
    };
  }

  const scaling = getDifficultyScalingFor(stage, req.difficulty ?? "Easy");
  const formation = stage.formation ?? { front: 0, back: 0, leaderIndex: 0 };
  const front = Math.max(0, Number(formation.front ?? 0) | 0);
  const back = Math.max(0, Number(formation.back ?? 0) | 0);
  const total = front + back;

  const baseFormation: BattleFormationDTO = {
    front,
    back,
    leaderIndex: Number(formation.leaderIndex ?? 0) | 0,
  };

  const wavesSrc: any[] = stage.waves ?? [];

  const waves: BattlePveWaveDTO[] = [];

  for (let w = 0; w < wavesSrc.length; w++) {
    const wave = wavesSrc[w];
    const waveIndex = Math.max(0, Number(wave?.waveIndex ?? w) | 0);
    const enemiesSrc: any[] = Array.isArray(wave?.enemies) ? wave.enemies : [];

    const enemies: BattlePveEnemyDTO[] = [];
    let slot = 0; // formation slot of the next valid enemy (unit ids keep the authored index)

    for (let i = 0; i < enemiesSrc.length; i++) {
      const e = enemiesSrc[i];
      const characterId = String(e?.characterId ?? "");
      if (!characterId) continue;

      const ch = getCharacterById(characterId);
      if (!ch) {
        return {
          ok: false,
          error: `CHAR_NOT_FOUND:${characterId}`,
          regionId,
          stageId,
          formation: baseFormation,
          waves: [],
        };
      }

      const stars = clampInt(e?.stars ?? 1, 1, 6);
      const authoredLevel = Math.max(1, Number(e?.level ?? 1) | 0);
      // Difficulty level bonus, capped at the star's max level; stats are then recomputed at that level.
      const level = scaling.levelBonus > 0 ? Math.min(maxLevelAtStar(stars), authoredLevel + scaling.levelBonus) : authoredLevel;
      const awakeningIndex = Math.max(0, Number(e?.awakeningIndex ?? 0) | 0);

      const statsFromMap = scaling.levelBonus > 0 ? null : buildStatsDTOFromMap(e);
      let stats: StatsDTO;

      if (statsFromMap) {
        stats = statsFromMap;
      } else {
        const computed = computeCharacterStats(ch, stars, level, awakeningIndex);
        if (computed.ok === false) {
          return {
            ok: false,
            error: computed.error,
            regionId,
            stageId,
            formation: baseFormation,
            waves: [],
          };
        }
        stats = computed.stats;
      }

      if (Math.abs(scaling.statMultiplier - 1) > 0.0001) {
        const multiplier = Math.max(0.01, scaling.statMultiplier);
        stats = {
          ...stats,
          hp: Math.round(stats.hp * multiplier),
          atk: Math.round(stats.atk * multiplier),
          def: Math.round(stats.def * multiplier),
        };
      }

      // Formation placement: valid enemies fill the front slots first, then the back slots
      // (slotIndex is the index within the row).
      const row: "Frontline" | "Backline" = slot < front ? "Frontline" : "Backline";
      const slotIndex = row === "Frontline" ? slot : slot - front;
      slot++;

      enemies.push({
        unitId: `W${waveIndex}_E${i}`,
        characterId,
        stars,
        level,
        awakeningIndex,
        isBoss: !!e?.isBoss,
        isLeader: !!e?.isLeader,
        row,
        slotIndex,
        stats,
      });
    }

    // Optional sanity: if enemies exceed formation slots, keep as-is and let client decide.
    // Optional sanity: if fewer enemies than slots, keep as-is (no invented fillers).

    waves.push({
      waveIndex,
      formation: baseFormation,
      enemies,
    });
  }

  return {
    ok: true,
    regionId,
    stageId,
    formation: baseFormation,
    waves,
  };
}
