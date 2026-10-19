import { computeCharacterStats } from "../../progression/character-stat-calculator";
import type { CharacterDTO, StatsDTO } from "../../../config/DTO/characterCatalogDto";
import { getMainStatValue, getRuneSetById } from "../../../config/RuneCatalog";
import {
  createEmptyBattleRuneSetEffects,
  mergeBattleRuneSetEffects,
  type BattleRuneSetEffects,
} from "../domain/rune-set-effects";
import type { RuneDto, SubstatDto } from "../../rune/rune.dto";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function createEmptyStats(): StatsDTO {
  return {
    hp: 0,
    atk: 0,
    def: 0,
    spd: 0,
    sh: 0,
    cr: 0,
    cd: 0,
    res: 0,
    acc: 0,
    eva: 0,
  };
}

export type BattleCompletedRuneSet = {
  setId: string;
  completedCount: number;
  scope: "SelfOnly" | "EntireTeam";
};

export type BuildPlayerBattleStatsResult = {
  baseStats: StatsDTO;
  finalStats: StatsDTO;
  equippedRunes: RuneDto[];
  completedSets: BattleCompletedRuneSet[];
  setEffects: BattleRuneSetEffects;
  teamAuraBonuses: StatsDTO;
  teamAuraSetEffects: BattleRuneSetEffects;
};

export type BuildPlayerBattleStatsInput = {
  character: CharacterDTO;
  star: number;
  level: number;
  awakeningIndex: number;
  equippedRunes?: RuneDto[];
};

function addPercentBonuses(target: StatsDTO, bonus?: {
  MaxHP?: number;
  Attack?: number;
  Defense?: number;
  Speed?: number;
  CritRate?: number;
  CritDamage?: number;
  Resistance?: number;
  Accuracy?: number;
  Evasion?: number;
} | null): void {
  if (!bonus) return;

  target.hp += Number(bonus.MaxHP ?? 0);
  target.atk += Number(bonus.Attack ?? 0);
  target.def += Number(bonus.Defense ?? 0);
  target.spd += Number(bonus.Speed ?? 0);
  target.cr += Number(bonus.CritRate ?? 0);
  target.cd += Number(bonus.CritDamage ?? 0);
  target.res += Number(bonus.Resistance ?? 0);
  target.acc += Number(bonus.Accuracy ?? 0);
  target.eva += Number(bonus.Evasion ?? 0);
}

function accumulateSetEffect(target: BattleRuneSetEffects, effect: { type?: string; valueA?: number; valueB?: number } | null | undefined): void {
  if (!effect?.type) return;

  switch (effect.type) {
    case "StartOfBattleImmunityTurns":
      target.startOfBattleImmunityTurns += Math.max(0, Math.round(Number(effect.valueA ?? 0)));
      break;

    case "ExtraTurnChance":
      target.extraTurnChance += Math.max(0, Number(effect.valueA ?? 0));
      break;

    case "StunOnHitChance":
      target.stunOnHitChance += Math.max(0, Number(effect.valueA ?? 0));
      break;

    case "CounterattackChance":
      target.counterattackChance += Math.max(0, Number(effect.valueA ?? 0));
      break;

    case "LifestealPercent":
      target.lifestealPercent += Math.max(0, Number(effect.valueA ?? 0));
      break;

    case "ATBGainPerHpLostPercent":
      target.atbGainPerHpLostPercent += Math.max(0, Number(effect.valueA ?? 0));
      break;

    case "DestroyMaxHpPercentPerHit":
      target.destroyMaxHpPercentPerHit += Math.max(0, Number(effect.valueA ?? 0));
      break;
  }
}

function addFlatStat(flatStats: StatsDTO, stat: string, value: number): void {
  switch (stat) {
    case "HPFlat":
      flatStats.hp += value;
      break;

    case "ATKFlat":
      flatStats.atk += value;
      break;

    case "DEFFlat":
      flatStats.def += value;
      break;

    case "SPD":
      flatStats.spd += value;
      break;

    case "ShieldFlat":
      flatStats.sh += value;
      break;
  }
}

function addPercentStat(percentStats: StatsDTO, stat: string, value: number): void {
  const pct = value / 100;

  switch (stat) {
    case "HPPercent":
      percentStats.hp += pct;
      break;

    case "ATKPercent":
      percentStats.atk += pct;
      break;

    case "DEFPercent":
      percentStats.def += pct;
      break;

    case "CritRatePercent":
      percentStats.cr += pct;
      break;

    case "CritDamagePercent":
      percentStats.cd += pct;
      break;

    case "ResistancePercent":
      percentStats.res += pct;
      break;

    case "AccuracyPercent":
      percentStats.acc += pct;
      break;

    case "EvasionPercent":
      percentStats.eva += pct;
      break;
  }
}

function accumulateRuneStat(flatStats: StatsDTO, percentStats: StatsDTO, stat: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  addFlatStat(flatStats, stat, value);
  addPercentStat(percentStats, stat, value);
}

function totalSubstatValue(substat: SubstatDto): number {
  return Math.max(0, Number(substat.value ?? 0)) + Math.max(0, Number(substat.grind ?? 0));
}

function composeFinalStats(baseStats: StatsDTO, flatStats: StatsDTO, percentStats: StatsDTO): StatsDTO {
  return {
    hp: Math.max(0, Math.round(baseStats.hp * (1 + percentStats.hp)) + Math.round(flatStats.hp)),
    atk: Math.max(0, Math.round(baseStats.atk * (1 + percentStats.atk)) + Math.round(flatStats.atk)),
    def: Math.max(0, Math.round(baseStats.def * (1 + percentStats.def)) + Math.round(flatStats.def)),
    spd: Math.max(0, Math.round(baseStats.spd * (1 + percentStats.spd)) + Math.round(flatStats.spd)),
    sh: Math.max(0, Math.round(baseStats.sh) + Math.round(flatStats.sh)),
    cr: clamp01(baseStats.cr + percentStats.cr),
    cd: clamp(baseStats.cd + percentStats.cd, 1, 5),
    res: clamp01(baseStats.res + percentStats.res),
    acc: clamp01(baseStats.acc + percentStats.acc),
    eva: clamp01(baseStats.eva + percentStats.eva),
  };
}

function addStats(target: StatsDTO, bonus?: StatsDTO | null): void {
  if (!bonus) return;
  target.hp += Number(bonus.hp ?? 0);
  target.atk += Number(bonus.atk ?? 0);
  target.def += Number(bonus.def ?? 0);
  target.spd += Number(bonus.spd ?? 0);
  target.sh += Number(bonus.sh ?? 0);
  target.cr += Number(bonus.cr ?? 0);
  target.cd += Number(bonus.cd ?? 0);
  target.res += Number(bonus.res ?? 0);
  target.acc += Number(bonus.acc ?? 0);
  target.eva += Number(bonus.eva ?? 0);
}

export function applyAdditionalBattleStatBonuses(
  baseStats: StatsDTO,
  currentStats: StatsDTO,
  percentBonuses?: StatsDTO | null
): StatsDTO {
  const bonus = percentBonuses ?? createEmptyStats();
  return {
    hp: Math.max(0, currentStats.hp + Math.round(baseStats.hp * bonus.hp)),
    atk: Math.max(0, currentStats.atk + Math.round(baseStats.atk * bonus.atk)),
    def: Math.max(0, currentStats.def + Math.round(baseStats.def * bonus.def)),
    spd: Math.max(0, currentStats.spd + Math.round(baseStats.spd * bonus.spd)),
    sh: Math.max(0, currentStats.sh + Math.round(baseStats.sh * bonus.sh)),
    cr: clamp01(currentStats.cr + bonus.cr),
    cd: clamp(currentStats.cd + bonus.cd, 1, 5),
    res: clamp01(currentStats.res + bonus.res),
    acc: clamp01(currentStats.acc + bonus.acc),
    eva: clamp01(currentStats.eva + bonus.eva),
  };
}

export function buildPlayerBattleStats(input: BuildPlayerBattleStatsInput): BuildPlayerBattleStatsResult {
  const baseResult = computeCharacterStats(input.character, input.star, input.level, input.awakeningIndex);
  if (!baseResult.ok) {
    const error = "error" in baseResult ? baseResult.error : "UNKNOWN";
    throw new Error(`[battle-core] unable to build player stats for character=${input.character.id}: ${error}`);
  }

  const equippedRunes = Array.isArray(input.equippedRunes) ? input.equippedRunes : [];
  if (equippedRunes.length === 0) {
    return {
      baseStats: baseResult.stats,
      finalStats: baseResult.stats,
      equippedRunes: [],
      completedSets: [],
      setEffects: createEmptyBattleRuneSetEffects(),
      teamAuraBonuses: createEmptyStats(),
      teamAuraSetEffects: createEmptyBattleRuneSetEffects(),
    };
  }

  const flatStats = createEmptyStats();
  const percentStats = createEmptyStats();
  const selfSetBonuses = createEmptyStats();
  const teamAuraBonuses = createEmptyStats();
  const setEffects = createEmptyBattleRuneSetEffects();
  const teamAuraSetEffects = createEmptyBattleRuneSetEffects();
  const setCounts = new Map<string, number>();

  for (const rune of equippedRunes) {
    const mainStatValue = Math.max(
      0,
      Math.round(
        Number(rune.mainStatValue ?? 0)
        || getMainStatValue(rune.mainStatType, rune.tier, rune.variant, rune.level)
      )
    );
    accumulateRuneStat(flatStats, percentStats, rune.mainStatType, mainStatValue);

    for (const substat of Array.isArray(rune.substats) ? rune.substats : []) {
      accumulateRuneStat(flatStats, percentStats, String(substat.stat ?? ""), totalSubstatValue(substat));
    }

    const setId = String(rune.setId ?? "").trim();
    if (!setId) continue;
    setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
  }

  const completedSets: BattleCompletedRuneSet[] = [];
  for (const [setId, count] of setCounts) {
    const setDef = getRuneSetById(setId);
    if (!setDef) continue;

    const requiredCount = Math.max(1, Math.floor(Number(setDef.requiredCount ?? 0)));
    const completedCount = Math.floor(count / requiredCount);
    if (completedCount <= 0) continue;

    completedSets.push({
      setId,
      completedCount,
      scope: setDef.scope,
    });

    for (let index = 0; index < completedCount; index += 1) {
      if (setDef.scope === "EntireTeam") {
        addPercentBonuses(teamAuraBonuses, setDef.percentBonuses);
        for (const effect of Array.isArray(setDef.specialEffects) ? setDef.specialEffects : []) {
          accumulateSetEffect(teamAuraSetEffects, effect);
        }
        continue;
      }

      addPercentBonuses(selfSetBonuses, setDef.percentBonuses);
      for (const effect of Array.isArray(setDef.specialEffects) ? setDef.specialEffects : []) {
        accumulateSetEffect(setEffects, effect);
      }
    }
  }

  addStats(percentStats, selfSetBonuses);

  return {
    baseStats: baseResult.stats,
    finalStats: composeFinalStats(baseResult.stats, flatStats, percentStats),
    equippedRunes,
    completedSets,
    setEffects,
    teamAuraBonuses,
    teamAuraSetEffects: mergeBattleRuneSetEffects(teamAuraSetEffects),
  };
}
