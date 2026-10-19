import { SkillEffectDTO } from "../types/battle-data";
import { resolveCombatFormula, type CombatFormulaSnapshot, type ResolvedCombatFormula } from "../domain/combat-formula";
import { BattleStatusEvent, BattleStatusOperationResult, BattleStatusState } from "../statuses/status-models";
import {
  applyStatus,
  boostTurnBar,
  changeRandomCooldown,
  changeStatusDurations,
  changeTurnBar,
  cleanseDebuffs,
  resolveDebuffRoll,
  stealBuffs,
  stripBuffs,
  transferDebuffs,
} from "../statuses/status-engine";
import { buildStatusSummary, defaultIsBuff } from "../statuses/status-rules";

export type StatusSubsystemOptions = {
  /** Source and target are on the same side: harmful effects skip the resistance roll. */
  sameSide?: boolean;
  /** The source is the acting unit (statuses it grants itself, or steals, skip the next end-of-turn tick). */
  skipNextTick?: boolean;
  /** Passive resolving the effect (recorded on statuses the owner grants itself). */
  passiveId?: string | null;
  skillId?: string | null;
  /** Precomputed Shield / Bomb value. */
  value?: number | null;
  /** Skills eligible for CooldownChange (defaults to the keys of `cooldowns`). */
  eligibleCooldownSkillIds?: string[];
  /** Max cooldown per skill (caps CooldownChange increases). */
  maxCooldowns?: Record<string, number>;
  /** Turn bar cap of the target (threshold * headroom). */
  maxTurnBar?: number;
  /** Turn bar cap of the source (AbsorbTurnBar gain). */
  sourceMaxTurnBar?: number;
};

function noop(state: BattleStatusState): BattleStatusOperationResult {
  return { ok: false, state, events: [] };
}

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function resisted(
  source: BattleStatusState,
  target: BattleStatusState,
  effectType: string,
  reason: "RESISTED" | "IMMUNITY",
  skillId: string | null
): BattleStatusOperationResult {
  const event: BattleStatusEvent = {
    type: "effect_resisted",
    targetId: target.unitId,
    sourceId: source.unitId,
    skillId,
    effectType,
    reason,
  };
  return { ok: false, state: target, events: [event] };
}

/**
 * Resistance gate for harmful non-status effects (Strip, StealBuffs, ATB decrease / absorb, cooldown increase,
 * TransferDebuffs, harmful ChangeStatusDuration). `irresistible` skips the resistance roll. Returns null when the
 * effect lands.
 */
function gateHarmful(
  effect: SkillEffectDTO,
  source: BattleStatusState,
  target: BattleStatusState,
  formulas: ResolvedCombatFormula,
  rng: () => number,
  options: StatusSubsystemOptions | undefined,
  blockedByImmunity: boolean
): BattleStatusOperationResult | null {
  if (options?.sameSide) return null;
  const skillId = options?.skillId ?? null;
  if (blockedByImmunity && buildStatusSummary(target).debuffImmune) {
    return resisted(source, target, effect.type, "IMMUNITY", skillId);
  }
  const outcome = resolveDebuffRoll(source, target, finiteOr(effect.baseChance, 1), formulas.accuracy, rng, !!effect.irresistible);
  if (outcome === "failed") return noop(target);
  if (outcome === "resisted") return resisted(source, target, effect.type, "RESISTED", skillId);
  return null;
}

/**
 * Executes a non-damage effect (ApplyStatus, Strip, StealBuffs, Cleanse, TurnBar, AbsorbTurnBar, CooldownChange,
 * TransferDebuffs, ChangeStatusDuration) from `source` on `target` (`formulaSnapshot` null = default combat formula).
 */
export function applyStatusSubsystemEffect(
  effect: SkillEffectDTO,
  source: BattleStatusState,
  target: BattleStatusState,
  formulaSnapshot: CombatFormulaSnapshot | ResolvedCombatFormula | null | undefined,
  rng: () => number,
  options?: StatusSubsystemOptions
): BattleStatusOperationResult {
  const formulas = resolveCombatFormula(formulaSnapshot);
  const skipNextTick = !!options?.skipNextTick && source.unitId === target.unitId;

  switch (effect.type) {
    case "ApplyStatus": {
      return applyStatus({
        source,
        target,
        status: effect.status,
        duration: finiteOr(effect.statusDuration, 0),
        magnitude: finiteOr(effect.statusMagnitude, 0),
        percentPerTurn: finiteOr(effect.statusPercentPerTurn, 0),
        isBuff: defaultIsBuff(effect.status),
        applyChance: finiteOr(effect.applyChance, 1),
        skipResistance: !!options?.sameSide,
        formulas,
        value: options?.value ?? null,
        skipNextTick,
        passiveId: source.unitId === target.unitId ? (options?.passiveId ?? null) : null,
        irresistible: !!effect.irresistible,
      }, rng);
    }

    case "Cleanse":
      return cleanseDebuffs(target, finiteOr(effect.buffCount, 1), rng);

    case "Strip": {
      const gate = gateHarmful(effect, source, target, formulas, rng, options, false);
      if (gate) return gate;
      return stripBuffs(target, finiteOr(effect.buffCount, 1), rng);
    }

    case "StealBuffs": {
      const gate = gateHarmful(effect, source, target, formulas, rng, options, false);
      if (gate) return gate;
      return stealBuffs(source, target, finiteOr(effect.buffCount, 1), rng, { formulas, skipNextTick: !!options?.skipNextTick });
    }

    case "TurnBar": {
      const magnitude = target.turnThreshold * Math.max(0, finiteOr(effect.turnBarAmount, 0));
      if (effect.turnBarIncrease !== false) return boostTurnBar(target, magnitude, options?.maxTurnBar);
      const gate = gateHarmful(effect, source, target, formulas, rng, options, true);
      if (gate) return gate;
      return changeTurnBar(target, -magnitude, options?.maxTurnBar);
    }

    case "AbsorbTurnBar": {
      if (source.unitId === target.unitId) return noop(target);
      const gate = gateHarmful(effect, source, target, formulas, rng, options, true);
      if (gate) return gate;
      const wanted = target.turnThreshold * Math.max(0, finiteOr(effect.turnBarAmount, 0));
      const removed = changeTurnBar(target, -Math.min(wanted, Math.max(0, target.turnBar)), options?.maxTurnBar);
      const amount = removed.events.reduce((sum, event) => sum + (event.type === "turn_bar_changed" ? -event.amount : 0), 0);
      if (amount <= 0) return noop(target);
      const absorbed: BattleStatusEvent = {
        type: "turn_bar_absorbed",
        targetId: target.unitId,
        sourceId: source.unitId,
        skillId: options?.skillId ?? null,
        amount,
      };
      const gained = boostTurnBar(source, amount, options?.sourceMaxTurnBar);
      return { ok: true, state: target, events: [absorbed, ...removed.events, ...gained.events] };
    }

    case "TransferDebuffs": {
      if (source.unitId === target.unitId) return noop(target);
      const gate = gateHarmful(effect, source, target, formulas, rng, options, true);
      if (gate) return gate;
      return transferDebuffs(source, target, finiteOr(effect.buffCount, 1), rng, { formulas });
    }

    case "ChangeStatusDuration": {
      const turns = Math.max(0, Math.floor(finiteOr(effect.cooldownTurns, 1)));
      const harmful = effect.isBuff === (effect.cooldownIncrease === false);
      if (harmful) {
        const gate = gateHarmful(effect, source, target, formulas, rng, options, false);
        if (gate) return gate;
      }
      return changeStatusDurations(target, !!effect.isBuff, effect.cooldownIncrease === false ? -turns : turns, source.unitId);
    }

    case "CooldownChange": {
      const turns = Math.max(0, Math.floor(finiteOr(effect.cooldownTurns, 1)));
      // buffCount = skills changed per target (0 = every eligible skill).
      const count = Math.floor(finiteOr(effect.buffCount, 1));
      if (effect.cooldownIncrease !== false) {
        const gate = gateHarmful(effect, source, target, formulas, rng, options, true);
        if (gate) return gate;
        return changeRandomCooldown(target, turns, rng, options?.eligibleCooldownSkillIds, options?.maxCooldowns, count);
      }
      return changeRandomCooldown(target, -turns, rng, options?.eligibleCooldownSkillIds, options?.maxCooldowns, count);
    }

    default:
      return noop(target);
  }
}
