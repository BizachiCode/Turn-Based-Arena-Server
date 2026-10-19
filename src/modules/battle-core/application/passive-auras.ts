import type { BattleEvent } from "../domain/battle-event";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import { listBattleUnits } from "../domain/battle-state-utils";
import { changeAuraMaxHp } from "../statuses/status-engine";
import { buildStatusSummary } from "../statuses/status-rules";
import type { BattleUnitStats } from "../statuses/status-models";
import type { CharacterPassiveAuraDTO } from "../types/battle-data";

/** Unit metadata key: the unit's combat stats without passive auras (written the first time an aura reaches it). */
export const AURA_BASE_STATS_METADATA_KEY = "auraBaseStats";
/** Unit metadata key: max HP currently added by passive auras. */
export const AURA_HP_METADATA_KEY = "auraHp";

type AuraDelta = { hp: number } & BattleUnitStats;

const RATE_KEYS = ["cr", "cd", "res", "acc", "eva"] as const;
const SCALED_KEYS = ["atk", "def", "spd"] as const;

function emptyDelta(): AuraDelta {
  return { hp: 0, atk: 0, def: 0, spd: 0, cr: 0, cd: 0, res: 0, acc: 0, eva: 0 };
}

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readStats(raw: unknown): BattleUnitStats | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of [...SCALED_KEYS, ...RATE_KEYS]) {
    if (typeof source[key] !== "number") return null;
    out[key] = source[key] as number;
  }
  return out as BattleUnitStats;
}

function copyStats(stats: BattleUnitStats): BattleUnitStats {
  return { atk: stats.atk, def: stats.def, spd: stats.spd, cr: stats.cr, cd: stats.cd, res: stats.res, acc: stats.acc, eva: stats.eva };
}

/** True while the aura of `owner` counts: alive (unless `activeWhileAlive` is false) and not under Oblivion. */
function isAuraActive(owner: BattleUnitState, aura: CharacterPassiveAuraDTO): boolean {
  if (owner.currentHp <= 0 && aura.activeWhileAlive !== false) return false;
  return !buildStatusSummary(owner).passivesSealed;
}

function auraReaches(aura: CharacterPassiveAuraDTO, owner: BattleUnitState, target: BattleUnitState): boolean {
  switch (aura.scope) {
    case "Self": if (owner.unitId !== target.unitId) return false; break;
    case "AllEnemies": if (owner.sideId === target.sideId) return false; break;
    default: if (owner.sideId !== target.sideId) return false; break;
  }
  const filter = Array.isArray(aura.elementFilter) ? aura.elementFilter : [];
  return filter.length === 0 || (!!target.elementId && filter.includes(target.elementId));
}

/** Adds one aura to the delta of `target` (`preAuraMaxHp` = max HP without auras). */
function accumulate(delta: AuraDelta, aura: CharacterPassiveAuraDTO, target: BattleUnitState, base: BattleUnitStats, preAuraMaxHp: number): void {
  const percent = finiteOr(aura.percent, 0);
  const flat = finiteOr(aura.flat, 0);
  switch (aura.stat) {
    case "MaxHP": delta.hp += Math.round(preAuraMaxHp * percent) + Math.round(flat); break;
    case "Attack": delta.atk += Math.round(base.atk * percent) + Math.round(flat); break;
    case "Defense": delta.def += Math.round(base.def * percent) + Math.round(flat); break;
    case "Speed": delta.spd += Math.round(base.spd * percent) + Math.round(flat); break;
    case "CritRate": delta.cr += percent + flat; break;
    case "CritDamage": delta.cd += percent + flat; break;
    case "Resistance": delta.res += percent + flat; break;
    case "Accuracy": delta.acc += percent + flat; break;
    case "Evasion": delta.eva += percent + flat; break;
  }
}

/**
 * Re-evaluates every passive aura of the battle (auras are live): each unit's stats become its stats without auras
 * plus the auras that currently reach it. An aura counts while its bearer is alive (`activeWhileAlive`) and not
 * under Oblivion. ATK / DEF / SPD percentages scale the unit's base stats, rates add the fraction, MaxHP percentages
 * scale the max HP without auras (`max_hp_changed(kind aura)` when the max HP changes). Units never reached by an
 * aura are left untouched. The engine calls this at battle start, after every effect and turn phase, and the PvE
 * session after a wave spawns.
 */
export function refreshPassiveAuras(state: BattleState): BattleEvent[] {
  const units = listBattleUnits(state);
  const owners = units.filter((unit) => (unit.passives ?? []).some((passive) => Array.isArray(passive.auras) && passive.auras.length > 0));
  const events: BattleEvent[] = [];

  for (const target of units) {
    const metadata = target.metadata ?? (target.metadata = {});
    const storedBase = readStats(metadata[AURA_BASE_STATS_METADATA_KEY]);
    const appliedHp = finiteOr(metadata[AURA_HP_METADATA_KEY], 0);
    const preAuraStats = storedBase ?? copyStats(target.stats);
    const base = target.baseStats ?? preAuraStats;
    const preAuraMaxHp = target.maxHp - appliedHp;

    const delta = emptyDelta();
    let reached = false;
    for (const owner of owners) {
      for (const passive of owner.passives ?? []) {
        for (const aura of Array.isArray(passive.auras) ? passive.auras : []) {
          if (!auraReaches(aura, owner, target) || !isAuraActive(owner, aura)) continue;
          reached = true;
          accumulate(delta, aura, target, base, preAuraMaxHp);
        }
      }
    }

    if (!reached && !storedBase) continue;
    if (!storedBase) metadata[AURA_BASE_STATS_METADATA_KEY] = copyStats(preAuraStats);

    for (const key of SCALED_KEYS) {
      target.stats[key] = delta[key] === 0 ? preAuraStats[key] : Math.max(0, preAuraStats[key] + delta[key]);
    }
    for (const key of RATE_KEYS) {
      if (delta[key] === 0) target.stats[key] = preAuraStats[key];
      else target.stats[key] = key === "cd" ? clamp(preAuraStats[key] + delta[key], 1, 5) : clamp(preAuraStats[key] + delta[key], 0, 1);
    }

    const hpChange = delta.hp - appliedHp;
    if (hpChange !== 0) {
      const changed = changeAuraMaxHp(target, hpChange);
      const applied = changed.reduce((sum, event) => sum + (event.type === "max_hp_changed" ? event.amount : 0), 0);
      metadata[AURA_HP_METADATA_KEY] = appliedHp + applied;
      events.push(...changed);
    } else if (!(AURA_HP_METADATA_KEY in metadata)) {
      metadata[AURA_HP_METADATA_KEY] = appliedHp;
    }
  }

  return events;
}
