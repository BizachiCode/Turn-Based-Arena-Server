import { StatusId, canonicalStatusId } from "../types/battle-data";
import {
  type CombatAccuracyFormula,
  type CombatFormulaSnapshot,
  type ResolvedCombatFormula,
  getStatusDefault,
  resolveCombatFormula,
} from "../domain/combat-formula";
import {
  BattleActiveStatus,
  BattleStatusEvent,
  BattleStatusOperationResult,
  BattleStatusState,
  DamageKind,
  StatusApplyBlockReason,
  StatusRemoveReason,
  UnitDeathCause,
} from "./status-models";
import {
  breaksOnDamage,
  buildStatusSummary,
  defaultIsBuff,
  isHardControlStatus,
  isExpired,
  isInstanceStackingStatus,
  isShieldStatus,
  isSuppressedByOblivion,
  survivesDeath,
} from "./status-rules";

/** Unit metadata key: max HP removed by Destroy effects so far (capped by the formula's `damage.destroyMaxHpCap`). */
export const DESTROYED_MAX_HP_METADATA_KEY = "destroyedMaxHp";


export type ApplyStatusParams = {
  source?: BattleStatusState | null;
  target: BattleStatusState;
  status: StatusId;
  duration: number;
  magnitude?: number;
  percentPerTurn?: number;
  isBuff?: boolean;
  applyChance?: number;
  isDispellable?: boolean;
  stacks?: number;
  maxStacks?: number;
  uniqueTag?: string | null;
  skipResistance?: boolean;
  /** Formula snapshot used for status defaults and the resistance model (defaults when omitted). */
  formulas?: CombatFormulaSnapshot | ResolvedCombatFormula | null;
  /** Explicit value payload (Shield absorb / Bomb damage). Computed from magnitude when omitted. */
  value?: number | null;
  /** Set when the bearer applies the status to itself during its own turn (skips the next end-of-turn tick). */
  skipNextTick?: boolean;
  /** Passive that grants the status (Oblivion suppression of passive-granted self statuses). */
  passiveId?: string | null;
  /** Overrides the recorded source id (defaults to `source.unitId`). */
  sourceId?: string | null;
  /** Debuffs skip the resistance roll (the base chance is still rolled; Immunity still blocks). */
  irresistible?: boolean;
};

export type ApplyDirectDamageParams = {
  target: BattleStatusState;
  amount: number;
  sourceId?: string | null;
  skillId?: string | null;
  canBreakSleep?: boolean;
  isCritical?: boolean;
  isGlancing?: boolean;
  isCrushing?: boolean;
  elementRelation?: number;
  hitIndex?: number;
  hitCount?: number;
  kind?: DamageKind;
};

export type ApplyDirectHealParams = {
  target: BattleStatusState;
  amount: number;
  sourceId?: string | null;
  skillId?: string | null;
  /** `lifesteal` marks life steal heals in `heal_applied`. */
  kind?: "lifesteal";
};

export type ApplyReviveParams = {
  target: BattleStatusState;
  hpPercent: number;
  sourceId?: string | null;
  skillId?: string | null;
  cleanseDebuffs?: boolean;
  shieldAmount?: number;
  turnBarAmount?: number;
  maxTurnBar?: number;
};

export type DebuffRollOutcome = "landed" | "failed" | "resisted";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function ensureState(state: BattleStatusState): BattleStatusState {
  if (!state.statuses) state.statuses = [];
  if (!state.cooldowns) state.cooldowns = {};
  if (!Number.isFinite(state.shield)) state.shield = 0;
  if (!Number.isFinite(state.currentHp)) state.currentHp = 0;
  if (!Number.isFinite(state.maxHp) || state.maxHp <= 0) state.maxHp = 1;
  if (!Number.isFinite(state.turnThreshold) || state.turnThreshold <= 0) state.turnThreshold = 1000;
  if (!Number.isFinite(state.turnBar)) state.turnBar = 0;
  return state;
}

function cloneStatus(status: BattleActiveStatus): BattleActiveStatus {
  return {
    status: status.status,
    remainingTurns: status.remainingTurns,
    magnitude: status.magnitude,
    percentPerTurn: status.percentPerTurn,
    isBuff: status.isBuff,
    isDispellable: status.isDispellable,
    stacks: status.stacks,
    maxStacks: status.maxStacks,
    uniqueTag: status.uniqueTag ?? null,
    sourceId: status.sourceId ?? null,
    value: status.value ?? null,
    skipNextTick: !!status.skipNextTick,
    passiveId: status.passiveId ?? null,
  };
}

function pickRandomIndex(length: number, rng: () => number): number {
  if (length <= 1) return 0;
  const rolled = Math.floor(clamp01(rng()) * length);
  return Math.max(0, Math.min(length - 1, rolled));
}

function countActiveInstances(state: BattleStatusState, status: StatusId): number {
  let count = 0;
  for (const active of state.statuses) {
    if (active.status === status && !isExpired(active)) count += 1;
  }
  return count;
}

/** Sum of the remaining value of every active Shield status. */
function statusShieldTotal(state: BattleStatusState): number {
  let total = 0;
  for (const active of state.statuses) {
    if (isShieldStatus(active.status) && !isExpired(active)) total += Math.max(0, active.value ?? 0);
  }
  return total;
}

/** Removes one status instance and emits its removal event (and the shield change for Shield statuses). */
function removeStatusInstance(
  state: BattleStatusState,
  instance: BattleActiveStatus,
  reason: StatusRemoveReason
): BattleStatusEvent[] {
  const index = state.statuses.indexOf(instance);
  if (index < 0) return [];
  state.statuses.splice(index, 1);

  const events: BattleStatusEvent[] = [{
    type: "status_removed",
    targetId: state.unitId,
    sourceId: instance.sourceId ?? null,
    status: instance.status,
    reason,
  }];

  if (isShieldStatus(instance.status)) {
    const remaining = Math.min(state.shield, Math.max(0, instance.value ?? 0));
    if (remaining > 0) {
      state.shield = Math.max(0, state.shield - remaining);
      events.push({
        type: "shield_changed",
        targetId: state.unitId,
        amount: -remaining,
        currentShield: state.shield,
      });
    }
  }

  return events;
}

function removeStatusesByPredicate(
  state: BattleStatusState,
  predicate: (status: BattleActiveStatus) => boolean,
  reason: StatusRemoveReason
): BattleStatusEvent[] {
  const events: BattleStatusEvent[] = [];
  for (const status of [...state.statuses]) {
    if (predicate(status)) events.push(...removeStatusInstance(state, status, reason));
  }
  return events;
}

function mergeStatus(existing: BattleActiveStatus, incoming: BattleActiveStatus): void {
  if (incoming.remainingTurns >= existing.remainingTurns) {
    existing.remainingTurns = incoming.remainingTurns;
    existing.skipNextTick = !!incoming.skipNextTick;
  }

  existing.magnitude = Math.max(existing.magnitude, incoming.magnitude);
  existing.percentPerTurn = Math.max(existing.percentPerTurn, incoming.percentPerTurn);

  if (existing.maxStacks > 1 || incoming.maxStacks > 1 || existing.maxStacks <= 0 || incoming.maxStacks <= 0) {
    const cap = Math.max(existing.maxStacks, incoming.maxStacks);
    existing.maxStacks = cap;
    const summed = Math.max(1, existing.stacks) + Math.max(1, incoming.stacks);
    existing.stacks = cap <= 0 ? summed : Math.min(cap, summed);
  }

  existing.isDispellable = existing.isDispellable && incoming.isDispellable;
  if (!existing.uniqueTag && incoming.uniqueTag) existing.uniqueTag = incoming.uniqueTag;
  if (!existing.sourceId && incoming.sourceId) existing.sourceId = incoming.sourceId;
  existing.passiveId = existing.passiveId && incoming.passiveId ? existing.passiveId : null;
}

function emitApplied(state: BattleStatusState, status: BattleActiveStatus, stacks: number): BattleStatusEvent {
  return {
    type: "status_applied",
    targetId: state.unitId,
    sourceId: status.sourceId ?? null,
    status: status.status,
    isBuff: status.isBuff,
    duration: status.remainingTurns,
    stacks,
    magnitude: status.magnitude,
    value: status.value ?? null,
  };
}

function emitBlocked(
  target: BattleStatusState,
  sourceId: string | null,
  status: StatusId,
  reason: StatusApplyBlockReason
): BattleStatusOperationResult {
  return {
    ok: false,
    state: target,
    reason,
    events: [{
      type: "status_blocked",
      targetId: target.unitId,
      sourceId,
      status,
      reason,
    }],
  };
}

/** Clears every status (except Unrevivable), shield and the turn bar of a unit that just died. */
function clearOnDeath(state: BattleStatusState): void {
  state.statuses = state.statuses.filter((active) => survivesDeath(active.status) && !isExpired(active));
  state.shield = 0;
  state.turnBar = 0;
}

type DamageOptions = {
  sourceId: string | null;
  skillId: string | null;
  kind: DamageKind | "periodic";
  periodicStatus?: StatusId;
  canBreakSleep: boolean;
  isCritical?: boolean;
  isGlancing?: boolean;
  isCrushing?: boolean;
  elementRelation?: number;
  hitIndex?: number;
  hitCount?: number;
};

function deathCauseOf(kind: DamageKind | "periodic"): UnitDeathCause {
  switch (kind) {
    case "periodic": return "continuous_damage";
    case "bomb": return "bomb";
    case "reflect": return "reflect";
    default: return "attack";
  }
}

/**
 * Shared damage pipeline: Invincibility, shields (Shield statuses first, then the innate pool), Endure,
 * HP loss, Sleep break and death. Always emits a damage event for a landed hit, even when fully absorbed.
 */
function applyDamage(state: BattleStatusState, rawAmount: number, options: DamageOptions): BattleStatusEvent[] {
  if (state.currentHp <= 0) return [];

  const summary = buildStatusSummary(state);
  if (summary.invulnerable) return [];

  let remaining = Math.max(0, Math.round(rawAmount));
  const events: BattleStatusEvent[] = [];

  let absorbed = 0;
  if (remaining > 0 && state.shield > 0) {
    for (const active of [...state.statuses]) {
      if (remaining <= 0) break;
      if (!isShieldStatus(active.status) || isExpired(active)) continue;
      const available = Math.max(0, active.value ?? 0);
      const used = Math.min(available, remaining);
      active.value = available - used;
      remaining -= used;
      absorbed += used;
    }

    const innate = Math.max(0, state.shield - absorbed - statusShieldTotal(state));
    const innateUsed = Math.min(innate, remaining);
    remaining -= innateUsed;
    absorbed += innateUsed;

    if (absorbed > 0) {
      state.shield = Math.max(0, state.shield - absorbed);
      events.push({
        type: "shield_changed",
        targetId: state.unitId,
        amount: -absorbed,
        currentShield: state.shield,
      });
    }

    for (const active of [...state.statuses]) {
      if (isShieldStatus(active.status) && !isExpired(active) && (active.value ?? 0) <= 0) {
        events.push(...removeStatusInstance(state, active, "consumed"));
      }
    }
  }

  let endured = false;
  if (remaining > 0 && remaining >= state.currentHp && summary.hasEndure) {
    remaining = Math.max(0, state.currentHp - 1);
    endured = true;

    const endure = state.statuses.find((active) =>
      active.status === "Endure"
      && !isExpired(active)
      && !isSuppressedByOblivion(state, active, summary.passivesSealed)
    );
    if (endure && endure.value !== null && endure.value !== undefined) {
      endure.value = Math.max(0, endure.value - 1);
      if (endure.value <= 0) events.push(...removeStatusInstance(state, endure, "consumed"));
    }
  }

  state.currentHp = Math.max(0, state.currentHp - remaining);

  if (options.kind === "periodic") {
    events.push({
      type: "periodic_damage",
      targetId: state.unitId,
      sourceId: options.sourceId,
      status: options.periodicStatus ?? "ContinuousDamage",
      amount: remaining,
      currentHp: state.currentHp,
      absorbed,
      endured,
    });
  } else {
    events.push({
      type: "damage_applied",
      targetId: state.unitId,
      sourceId: options.sourceId,
      skillId: options.skillId,
      amount: remaining,
      currentHp: state.currentHp,
      currentShield: state.shield,
      isCritical: !!options.isCritical,
      isGlancing: !!options.isGlancing,
      isCrushing: !!options.isCrushing,
      elementRelation: options.elementRelation ?? 0,
      hitIndex: options.hitIndex ?? 0,
      hitCount: options.hitCount ?? 1,
      absorbed,
      kind: options.kind,
      endured,
    });
  }

  if (state.currentHp <= 0) {
    state.currentHp = 0;
    clearOnDeath(state);
    events.push({
      type: "unit_died",
      targetId: state.unitId,
      sourceId: options.sourceId,
      cause: deathCauseOf(options.kind),
    });
    return events;
  }

  if (options.canBreakSleep && (remaining + absorbed) > 0) {
    events.push(...removeStatusesByPredicate(
      state,
      (active) => breaksOnDamage(active.status) && !isExpired(active),
      "damage_break"
    ));
  }

  return events;
}

function applyPeriodicHealing(state: BattleStatusState, amount: number, status: BattleActiveStatus): BattleStatusEvent[] {
  if (state.currentHp <= 0) return [];
  const summary = buildStatusSummary(state);
  if (summary.healBlocked) {
    return [{ type: "heal_blocked", targetId: state.unitId, sourceId: status.sourceId ?? null, skillId: null }];
  }

  const heal = Math.max(0, Math.round(amount));
  if (heal <= 0) return [];

  const restored = Math.min(heal, Math.max(0, state.maxHp - state.currentHp));
  state.currentHp += restored;
  return [{
    type: "periodic_heal",
    targetId: state.unitId,
    sourceId: status.sourceId ?? null,
    status: status.status,
    amount: restored,
    currentHp: state.currentHp,
  }];
}

function computePeriodicAmount(state: BattleStatusState, status: BattleActiveStatus): number {
  let percent = status.percentPerTurn > 0 ? status.percentPerTurn : status.magnitude;
  if (!(percent > 0)) {
    const fallback = status.status === "HpRegen" ? 0.15 : 0.05;
    percent = fallback;
  }
  const scaled = Math.round(state.maxHp * percent * Math.max(1, status.stacks));
  return Math.max(1, scaled);
}

export function createBattleStatusState(
  seed: Partial<BattleStatusState> & Pick<BattleStatusState, "unitId" | "stats" | "maxHp">
): BattleStatusState {
  return ensureState({
    unitId: seed.unitId,
    stats: seed.stats,
    currentHp: seed.currentHp ?? seed.maxHp,
    maxHp: seed.maxHp,
    shield: seed.shield ?? 0,
    turnBar: seed.turnBar ?? 0,
    turnThreshold: seed.turnThreshold ?? 1000,
    cooldowns: { ...(seed.cooldowns ?? {}) },
    statuses: [...(seed.statuses ?? [])].map(cloneStatus),
  });
}

export function hasStatus(state: BattleStatusState, statusId: StatusId): boolean {
  ensureState(state);
  const wanted = canonicalStatusId(statusId);
  return state.statuses.some((status) => canonicalStatusId(status.status) === wanted && !isExpired(status));
}

/**
 * Resolves whether a harmful effect lands.
 * `resist_floor` model: roll `baseChance` (skipped at >= 1), then the target resists with
 * `clamp(max(minimumResistChance, RES - ACC), 0, maximumResistChance)` (skipped at <= 0).
 * `linear` model: one roll against `clamp(base + (ACC - RES) * weight, minimumDebuffChance, maximumDebuffChance)`.
 * `irresistible`: only the base chance is rolled (skipped at >= 1), in both models.
 */
export function resolveDebuffRoll(
  source: { stats?: { acc: number } } | null | undefined,
  target: { stats?: { res: number } },
  baseChance: number,
  accuracy: Partial<CombatAccuracyFormula> | null | undefined,
  rng: () => number,
  irresistible: boolean = false
): DebuffRollOutcome {
  const sourceAcc = Number(source?.stats?.acc ?? 0) || 0;
  const targetRes = Number(target?.stats?.res ?? 0) || 0;
  const model = accuracy?.debuffResistanceModel ?? "resist_floor";

  if (irresistible) {
    const base = clamp01(baseChance);
    if (base <= 0) return "failed";
    if (base < 1 && !(rng() < base)) return "failed";
    return "landed";
  }

  if (model === "linear") {
    const weight = Number.isFinite(accuracy?.accuracyVsResistanceWeight) ? Number(accuracy?.accuracyVsResistanceWeight) : 1;
    const min = Number.isFinite(accuracy?.minimumDebuffChance) ? Number(accuracy?.minimumDebuffChance) : 0;
    const max = Number.isFinite(accuracy?.maximumDebuffChance) ? Number(accuracy?.maximumDebuffChance) : 1;
    const chance = Math.max(min, Math.min(max, baseChance + ((sourceAcc - targetRes) * weight)));
    return rng() < chance ? "landed" : "resisted";
  }

  const base = clamp01(baseChance);
  if (base <= 0) return "failed";
  if (base < 1 && !(rng() < base)) return "failed";

  const minResist = Number.isFinite(accuracy?.minimumResistChance) ? Number(accuracy?.minimumResistChance) : 0.15;
  const maxResist = Number.isFinite(accuracy?.maximumResistChance) ? Number(accuracy?.maximumResistChance) : 1;
  const resist = Math.max(0, Math.min(maxResist, Math.max(minResist, targetRes - sourceAcc)));
  if (resist > 0 && rng() < resist) return "resisted";
  return "landed";
}

function computeStatusValue(params: ApplyStatusParams, magnitude: number, target: BattleStatusState): number | null {
  if (Number.isFinite(params.value) && params.value !== null && params.value !== undefined) {
    return Math.max(0, Math.round(params.value as number));
  }

  switch (params.status) {
    case "Berserk": {
      const authored = Number.isFinite(params.magnitude) ? Number(params.magnitude) : 0;
      return authored !== 0 ? authored : getStatusDefault(resolveCombatFormula(params.formulas ?? null), "SpeedUp").magnitude;
    }
    case "Shield": {
      if (magnitude > 1) return Math.max(0, Math.round(magnitude));
      const basis = params.source?.maxHp ?? target.maxHp;
      return Math.max(0, Math.round(basis * magnitude));
    }
    case "Bomb":
      return Math.max(0, Math.round(Math.max(0, params.source?.stats?.atk ?? 0) * magnitude));
    case "Endure":
      return magnitude > 0 ? Math.max(1, Math.floor(magnitude)) : null;
    default:
      return null;
  }
}

export function applyStatus(rawParams: ApplyStatusParams, rng: () => number = Math.random): BattleStatusOperationResult {
  const params: ApplyStatusParams = { ...rawParams, status: canonicalStatusId(rawParams.status) };
  const target = ensureState(params.target);
  const formulas = resolveCombatFormula(params.formulas ?? null);
  const defaults = getStatusDefault(formulas, params.status);
  const sourceId = params.sourceId !== undefined ? params.sourceId : (params.source?.unitId ?? null);
  const isBuff = params.isBuff ?? defaultIsBuff(params.status);
  const duration = Math.max(0, Math.floor(Number(params.duration ?? 0) || 0));

  if (duration <= 0 || target.currentHp <= 0) {
    return { ok: false, state: target, events: [], reason: "INVALID" };
  }

  const authoredMagnitude = Number.isFinite(params.magnitude) ? Number(params.magnitude) : 0;
  const authoredPercent = Number.isFinite(params.percentPerTurn) ? Number(params.percentPerTurn) : 0;
  // Berserk = AttackUp + SpeedUp: an unauthored magnitude takes the AttackUp default (the SPD part goes to `value`).
  const fallbackMagnitude = params.status === "Berserk" ? getStatusDefault(formulas, "AttackUp").magnitude : defaults.magnitude;
  const magnitude = authoredMagnitude !== 0 ? authoredMagnitude : fallbackMagnitude;
  const percentPerTurn = authoredPercent !== 0 ? authoredPercent : defaults.percentPerTurn;

  const summary = buildStatusSummary(target);
  if (!isBuff && summary.debuffImmune) return emitBlocked(target, sourceId, params.status, "IMMUNITY");
  if (!isBuff && summary.hardControlImmune && isHardControlStatus(params.status)) return emitBlocked(target, sourceId, params.status, "IMMUNITY");
  if (isBuff && summary.buffBlocked) return emitBlocked(target, sourceId, params.status, "BENEFICIAL_BLOCK");

  if (!isBuff && !params.skipResistance) {
    const outcome = resolveDebuffRoll(params.source, target, params.applyChance ?? 1, formulas.accuracy, rng, !!params.irresistible);
    if (outcome === "failed") return { ok: false, state: target, events: [], reason: "RESISTED" };
    if (outcome === "resisted") return emitBlocked(target, sourceId, params.status, "RESISTED");
  }

  const instanceStacking = isInstanceStackingStatus(params.status);
  const incoming: BattleActiveStatus = {
    status: params.status,
    remainingTurns: duration,
    magnitude,
    percentPerTurn,
    isBuff,
    isDispellable: params.isDispellable !== false,
    stacks: Math.max(1, Math.floor(params.stacks ?? 1)),
    maxStacks: instanceStacking
      ? Math.max(1, Math.floor(params.maxStacks ?? defaults.maxStacks))
      : Math.floor(params.maxStacks ?? 1),
    uniqueTag: params.uniqueTag ?? null,
    sourceId,
    value: computeStatusValue(params, magnitude, target),
    skipNextTick: !!params.skipNextTick,
    passiveId: params.passiveId ?? null,
  };

  const events: BattleStatusEvent[] = [];

  if (isShieldStatus(incoming.status)) {
    const shieldValue = Math.max(0, incoming.value ?? 0);
    if (shieldValue <= 0) return { ok: false, state: target, events: [], reason: "INVALID" };

    const existing = target.statuses.find((active) => isShieldStatus(active.status) && !isExpired(active));
    if (existing) {
      const previous = Math.max(0, existing.value ?? 0);
      const nextValue = Math.max(previous, shieldValue);
      mergeStatus(existing, incoming);
      existing.value = nextValue;
      const gain = nextValue - previous;
      if (gain > 0) {
        target.shield += gain;
        events.push({ type: "shield_changed", targetId: target.unitId, amount: gain, currentShield: target.shield });
      }
      events.push(emitApplied(target, existing, existing.stacks));
      return { ok: true, state: target, events };
    }

    target.statuses.push(incoming);
    target.shield += shieldValue;
    events.push({ type: "shield_changed", targetId: target.unitId, amount: shieldValue, currentShield: target.shield });
    events.push(emitApplied(target, incoming, 1));
    return { ok: true, state: target, events };
  }

  if (instanceStacking) {
    const count = countActiveInstances(target, incoming.status);
    if (count >= incoming.maxStacks) return emitBlocked(target, sourceId, incoming.status, "MAX_STACKS");
    target.statuses.push(incoming);
    events.push(emitApplied(target, incoming, count + 1));
    return { ok: true, state: target, events };
  }

  if (incoming.uniqueTag) {
    events.push(...removeStatusesByPredicate(
      target,
      (active) => !isExpired(active) && active.uniqueTag === incoming.uniqueTag && active.status !== incoming.status,
      "replaced"
    ));
  }

  const existing = target.statuses.find((active) => active.status === incoming.status && !isExpired(active));
  if (existing) {
    mergeStatus(existing, incoming);
    if (incoming.value !== null && incoming.value !== undefined) {
      existing.value = Math.max(existing.value ?? 0, incoming.value);
    }
    events.push(emitApplied(target, existing, existing.stacks));
    return { ok: true, state: target, events };
  }

  target.statuses.push(incoming);
  events.push(emitApplied(target, incoming, incoming.stacks));
  return { ok: true, state: target, events };
}

function pickAndRemove(
  state: BattleStatusState,
  candidates: BattleActiveStatus[],
  count: number,
  reason: StatusRemoveReason,
  rng: () => number,
  onRemoved?: (picked: BattleActiveStatus) => BattleStatusEvent[] | null
): BattleStatusEvent[] {
  const events: BattleStatusEvent[] = [];
  const limit = count <= 0 ? candidates.length : count;

  for (let i = 0; i < limit && candidates.length > 0; i++) {
    const idx = pickRandomIndex(candidates.length, rng);
    const [picked] = candidates.splice(idx, 1);
    if (onRemoved) {
      const extra = onRemoved(picked);
      if (extra === null) continue;
      events.push(...removeStatusInstance(state, picked, reason));
      events.push(...extra);
    } else {
      events.push(...removeStatusInstance(state, picked, reason));
    }
  }

  return events;
}

/** Removes `count` random dispellable buffs (`count <= 0` removes all). */
export function stripBuffs(
  target: BattleStatusState,
  count: number,
  rng: () => number = Math.random
): BattleStatusOperationResult {
  const state = ensureState(target);
  const removable = state.statuses.filter((status) => status.isBuff && !isExpired(status) && status.isDispellable);
  const events = pickAndRemove(state, removable, count, "strip", rng);
  return { ok: events.length > 0, state, events };
}

/** Removes `count` random dispellable debuffs (`count <= 0` removes all). */
export function cleanseDebuffs(
  target: BattleStatusState,
  count: number,
  rng: () => number = Math.random
): BattleStatusOperationResult {
  const state = ensureState(target);
  const removable = state.statuses.filter((status) => !status.isBuff && !isExpired(status) && status.isDispellable);
  const events = pickAndRemove(state, removable, count, "cleanse", rng);
  return { ok: events.length > 0, state, events };
}

/** Moves `count` random dispellable buffs from `target` to `source` (`count <= 0` steals all). */
export function stealBuffs(
  source: BattleStatusState,
  target: BattleStatusState,
  count: number,
  rng: () => number = Math.random,
  options?: { formulas?: CombatFormulaSnapshot | ResolvedCombatFormula | null; skipNextTick?: boolean }
): BattleStatusOperationResult {
  const sourceState = ensureState(source);
  const targetState = ensureState(target);
  const candidates = targetState.statuses.filter((status) => status.isBuff && !isExpired(status) && status.isDispellable);

  const events = pickAndRemove(targetState, candidates, count, "steal", rng, (picked) => {
    const applied = applyStatus({
      source: targetState,
      target: sourceState,
      status: picked.status,
      duration: picked.remainingTurns,
      magnitude: picked.magnitude,
      percentPerTurn: picked.percentPerTurn,
      isBuff: true,
      isDispellable: picked.isDispellable,
      stacks: picked.stacks,
      maxStacks: picked.maxStacks,
      uniqueTag: picked.uniqueTag ?? null,
      value: picked.value ?? null,
      skipResistance: true,
      formulas: options?.formulas ?? null,
      skipNextTick: options?.skipNextTick,
    }, rng);
    return applied.ok ? applied.events : null;
  });

  return { ok: events.length > 0, state: targetState, events };
}

/** Changes the turn bar by `rawDelta`, clamped to [0, maxTurnBar]. The event carries the applied delta. */
export function changeTurnBar(
  target: BattleStatusState,
  rawDelta: number,
  maxTurnBar?: number
): BattleStatusOperationResult {
  const state = ensureState(target);
  const amount = Number.isFinite(rawDelta) ? rawDelta : 0;
  if (amount === 0 || state.currentHp <= 0) return { ok: false, state, events: [] };

  const cap = Number.isFinite(maxTurnBar) && (maxTurnBar as number) > 0 ? (maxTurnBar as number) : state.turnThreshold * 1.2;
  const previous = state.turnBar;
  const next = Math.max(0, Math.min(cap, previous + amount));
  if (next === previous) return { ok: false, state, events: [] };

  state.turnBar = next;
  return {
    ok: true,
    state,
    events: [{
      type: "turn_bar_changed",
      targetId: state.unitId,
      amount: next - previous,
      currentTurnBar: next,
    }],
  };
}

/** Freeze-aware attack bar increase from an effect (skills, passives, Nemesis, absorbed bars): blocked by Freeze. */
export function boostTurnBar(target: BattleStatusState, rawDelta: number, maxTurnBar?: number): BattleStatusOperationResult {
  const state = ensureState(target);
  if (buildStatusSummary(state).turnBarIncreaseBlocked) return { ok: false, state, events: [] };
  return changeTurnBar(state, rawDelta, maxTurnBar);
}

/**
 * Destroy: removes `round(rawAmount)` from the max HP of a living unit. Over the whole battle at most `maxHpCap`
 * (combat formula `damage.destroyMaxHpCap`) of its original max HP (current max HP + already destroyed) can be
 * removed; the destroyed amount is kept in `metadata.destroyedMaxHp`.
 */
export function destroyMaxHp(
  target: BattleStatusState & { metadata?: Record<string, unknown> },
  rawAmount: number,
  sourceId: string | null,
  maxHpCap: number
): BattleStatusOperationResult {
  const state = ensureState(target);
  if (state.currentHp <= 0) return { ok: false, state, events: [] };

  const metadata = target.metadata ?? (target.metadata = {});
  const raw = metadata[DESTROYED_MAX_HP_METADATA_KEY];
  const destroyed = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  const cap = Math.floor((state.maxHp + destroyed) * maxHpCap);
  const amount = Math.min(Math.max(0, Math.round(Number(rawAmount ?? 0))), Math.max(0, cap - destroyed));
  if (amount <= 0) return { ok: false, state, events: [] };

  const nextMaxHp = Math.max(1, state.maxHp - amount);
  const appliedAmount = nextMaxHp - state.maxHp;
  if (appliedAmount === 0) return { ok: false, state, events: [] };

  state.maxHp = nextMaxHp;
  state.currentHp = Math.min(state.currentHp, state.maxHp);
  metadata[DESTROYED_MAX_HP_METADATA_KEY] = destroyed - appliedAmount;

  return {
    ok: true,
    state,
    events: [{
      type: "max_hp_changed",
      targetId: state.unitId,
      sourceId,
      amount: appliedAmount,
      currentMaxHp: state.maxHp,
      currentHp: state.currentHp,
      kind: "destroy",
    }],
  };
}

/**
 * Changes the max HP of a unit by `delta` (passive auras). A living unit gains the same current HP on an increase and
 * keeps at most its new max HP on a decrease (never below 1); a dead unit only changes its max HP.
 */
export function changeAuraMaxHp(target: BattleStatusState, delta: number): BattleStatusEvent[] {
  const state = ensureState(target);
  if (!Number.isFinite(delta) || delta === 0) return [];
  const nextMaxHp = Math.max(1, state.maxHp + delta);
  const applied = nextMaxHp - state.maxHp;
  if (applied === 0) return [];

  state.maxHp = nextMaxHp;
  if (state.currentHp > 0) {
    state.currentHp = applied > 0 ? state.currentHp + applied : Math.max(1, Math.min(state.currentHp, state.maxHp));
  }

  return [{
    type: "max_hp_changed",
    targetId: state.unitId,
    sourceId: null,
    amount: applied,
    currentMaxHp: state.maxHp,
    currentHp: state.currentHp,
    kind: "aura",
  }];
}

/**
 * Moves up to `count` random dispellable harmful effects (`count <= 0` = all) from `source` to `target`, keeping their
 * remaining turns, magnitude and value; the moved statuses are recorded as inflicted by `source`. A status the
 * target cannot receive (Immunity, max stacks) stays on the source.
 */
export function transferDebuffs(
  source: BattleStatusState,
  target: BattleStatusState,
  count: number,
  rng: () => number = Math.random,
  options?: { formulas?: CombatFormulaSnapshot | ResolvedCombatFormula | null }
): BattleStatusOperationResult {
  const sourceState = ensureState(source);
  const targetState = ensureState(target);
  if (sourceState.unitId === targetState.unitId || targetState.currentHp <= 0) return { ok: false, state: targetState, events: [] };
  const candidates = sourceState.statuses.filter((status) => !status.isBuff && !isExpired(status) && status.isDispellable);

  const events = pickAndRemove(sourceState, candidates, count, "transfer", rng, (picked) => {
    const applied = applyStatus({
      source: sourceState,
      target: targetState,
      status: picked.status,
      duration: picked.remainingTurns,
      magnitude: picked.magnitude,
      percentPerTurn: picked.percentPerTurn,
      isBuff: false,
      isDispellable: picked.isDispellable,
      stacks: picked.stacks,
      maxStacks: picked.maxStacks,
      uniqueTag: picked.uniqueTag ?? null,
      value: picked.value ?? null,
      skipResistance: true,
      formulas: options?.formulas ?? null,
    }, rng);
    return applied.ok ? applied.events : null;
  });

  return { ok: events.length > 0, state: targetState, events };
}

/**
 * Adds `delta` turns to every active buff (`buffs = true`) or debuff of a unit (`status_duration_changed` per
 * instance). Statuses brought to 0 turns are removed (`status_removed(duration)`, a Bomb is removed without
 * detonating).
 */
export function changeStatusDurations(
  target: BattleStatusState,
  buffs: boolean,
  delta: number,
  sourceId: string | null
): BattleStatusOperationResult {
  const state = ensureState(target);
  const turns = Math.trunc(Number(delta) || 0);
  if (turns === 0 || state.currentHp <= 0) return { ok: false, state, events: [] };

  const events: BattleStatusEvent[] = [];
  for (const active of [...state.statuses]) {
    if (isExpired(active) || active.isBuff !== buffs) continue;
    const next = Math.max(0, active.remainingTurns + turns);
    const amount = next - active.remainingTurns;
    if (amount === 0) continue;
    active.remainingTurns = next;
    events.push({
      type: "status_duration_changed",
      targetId: state.unitId,
      sourceId,
      status: active.status,
      isBuff: active.isBuff,
      amount,
      remainingTurns: next,
    });
    if (next <= 0) events.push(...removeStatusInstance(state, active, "duration"));
  }

  return { ok: events.length > 0, state, events };
}

export function applyDirectDamage(params: ApplyDirectDamageParams): BattleStatusOperationResult {
  const state = ensureState(params.target);
  const events = applyDamage(state, params.amount, {
    sourceId: params.sourceId ?? null,
    skillId: params.skillId ?? null,
    kind: params.kind ?? "attack",
    canBreakSleep: params.canBreakSleep !== false,
    isCritical: params.isCritical,
    isGlancing: params.isGlancing,
    isCrushing: params.isCrushing,
    elementRelation: params.elementRelation,
    hitIndex: params.hitIndex,
    hitCount: params.hitCount,
  });

  return { ok: events.length > 0, state, events };
}

export function applyDirectHeal(params: ApplyDirectHealParams): BattleStatusOperationResult {
  const state = ensureState(params.target);
  if (state.currentHp <= 0) return { ok: false, state, events: [] };

  const amount = Math.max(0, Math.round(params.amount));
  if (amount <= 0) return { ok: false, state, events: [] };

  const summary = buildStatusSummary(state);
  if (summary.healBlocked) {
    return {
      ok: false,
      state,
      events: [{ type: "heal_blocked", targetId: state.unitId, sourceId: params.sourceId ?? null, skillId: params.skillId ?? null }],
    };
  }

  const restored = Math.min(amount, Math.max(0, state.maxHp - state.currentHp));
  state.currentHp += restored;
  return {
    ok: true,
    state,
    events: [{
      type: "heal_applied",
      targetId: state.unitId,
      sourceId: params.sourceId ?? null,
      skillId: params.skillId ?? null,
      amount: restored,
      currentHp: state.currentHp,
      overheal: amount - restored,
      ...(params.kind ? { kind: params.kind } : {}),
    }],
  };
}

/** Adds an innate (non-expiring) shield, e.g. from revive. */
export function addInnateShield(target: BattleStatusState, rawAmount: number): BattleStatusEvent[] {
  const state = ensureState(target);
  const gain = Math.max(0, Math.round(rawAmount));
  if (gain <= 0) return [];
  state.shield += gain;
  return [{ type: "shield_changed", targetId: state.unitId, amount: gain, currentShield: state.shield }];
}

export function applyRevive(params: ApplyReviveParams): BattleStatusOperationResult {
  const state = ensureState(params.target);
  if (state.currentHp > 0) return { ok: false, state, events: [] };

  if (buildStatusSummary(state).unrevivable) {
    return {
      ok: false,
      state,
      events: [{
        type: "revive_blocked",
        targetId: state.unitId,
        sourceId: params.sourceId ?? null,
        skillId: params.skillId ?? null,
        reason: "UNREVIVABLE",
      }],
    };
  }

  const events: BattleStatusEvent[] = [];
  const revivedHp = Math.max(1, Math.round(state.maxHp * clamp01(params.hpPercent)));
  state.currentHp = revivedHp;

  let cleansedDebuffs = 0;
  if (params.cleanseDebuffs) {
    const removed = removeStatusesByPredicate(state, (status) => !status.isBuff, "cleanse");
    cleansedDebuffs = removed.filter((event) => event.type === "status_removed").length;
    events.push(...removed);
  }

  let grantedShield = 0;
  if (params.shieldAmount && params.shieldAmount > 0) {
    const shieldEvents = addInnateShield(state, params.shieldAmount);
    events.push(...shieldEvents);
    grantedShield = Math.max(0, Math.round(params.shieldAmount));
  }

  if (params.turnBarAmount && params.turnBarAmount !== 0) {
    events.push(...changeTurnBar(state, params.turnBarAmount, params.maxTurnBar).events);
  }

  events.push({
    type: "unit_revived",
    targetId: state.unitId,
    sourceId: params.sourceId ?? null,
    revivedHp,
    currentHp: state.currentHp,
    grantedShield,
    currentTurnBar: state.turnBar,
    cleansedDebuffs,
  });

  return { ok: true, state, events };
}

/**
 * Changes the cooldown of `count` random eligible skills (without repetition; `count <= 0` = every eligible skill, in
 * order, without RNG) by `deltaTurns`. `eligibleSkillIds` defaults to the keys of `cooldowns`; `maxCooldowns` caps
 * increases per skill. One `cooldown_changed` per skill whose cooldown changed.
 */
export function changeRandomCooldown(
  target: BattleStatusState,
  deltaTurns: number,
  rng: () => number = Math.random,
  eligibleSkillIds?: string[],
  maxCooldowns?: Record<string, number>,
  count: number = 1
): BattleStatusOperationResult {
  const state = ensureState(target);
  const skillIds = Array.isArray(eligibleSkillIds) ? eligibleSkillIds : Object.keys(state.cooldowns);
  if (skillIds.length === 0 || deltaTurns === 0) return { ok: false, state, events: [] };

  const pool = [...skillIds];
  const picked: string[] = [];
  if (count <= 0) {
    picked.push(...pool);
  } else {
    for (let i = 0; i < count && pool.length > 0; i++) picked.push(pool.splice(pickRandomIndex(pool.length, rng), 1)[0]);
  }

  const events: BattleStatusEvent[] = [];
  for (const skillId of picked) {
    const current = state.cooldowns[skillId] ?? 0;
    const cap = maxCooldowns && Number.isFinite(maxCooldowns[skillId]) ? maxCooldowns[skillId] : Number.POSITIVE_INFINITY;
    const next = Math.max(0, Math.min(cap, current + deltaTurns));
    if (next === current) continue;
    state.cooldowns[skillId] = next;
    events.push({
      type: "cooldown_changed",
      targetId: state.unitId,
      skillId,
      amount: next - current,
      currentCooldown: next,
    });
  }

  return { ok: events.length > 0, state, events };
}

/**
 * Start-of-turn periodic effects: every ContinuousDamage instance deals its damage (stops when the unit
 * dies), then HpRegen heals. Continuous damage does not break Sleep.
 */
export function tickStatusesStartOfTurn(target: BattleStatusState): BattleStatusOperationResult {
  const state = ensureState(target);
  const events: BattleStatusEvent[] = [];

  for (const status of [...state.statuses]) {
    if (state.currentHp <= 0) break;
    if (isExpired(status) || status.status !== "ContinuousDamage") continue;
    events.push(...applyDamage(state, computePeriodicAmount(state, status), {
      sourceId: status.sourceId ?? null,
      skillId: null,
      kind: "periodic",
      periodicStatus: status.status,
      canBreakSleep: false,
    }));
  }

  for (const status of [...state.statuses]) {
    if (state.currentHp <= 0) break;
    if (isExpired(status) || status.status !== "HpRegen") continue;
    events.push(...applyPeriodicHealing(state, computePeriodicAmount(state, status), status));
  }

  return { ok: events.length > 0, state, events };
}

/**
 * End-of-turn tick: every status loses one turn (except statuses the unit applied to itself this turn),
 * then expired statuses are removed. Expired Shields remove their remaining absorb; expired Bombs detonate
 * (damage = value snapshot) and stun the bearer for 1 turn unless it is immune.
 */
export function tickStatusesEndOfTurn(
  target: BattleStatusState,
  options?: { formulas?: CombatFormulaSnapshot | ResolvedCombatFormula | null; rng?: () => number }
): BattleStatusOperationResult {
  const state = ensureState(target);
  const events: BattleStatusEvent[] = [];
  if (state.currentHp <= 0) return { ok: false, state, events };

  for (const status of state.statuses) {
    if (isExpired(status)) continue;
    if (status.skipNextTick) {
      status.skipNextTick = false;
      continue;
    }
    status.remainingTurns -= 1;
    events.push({
      type: "status_tick",
      targetId: state.unitId,
      status: status.status,
      remainingTurns: status.remainingTurns,
      isBuff: status.isBuff,
    });
  }

  for (const status of [...state.statuses]) {
    if (!isExpired(status)) continue;
    if (state.statuses.indexOf(status) < 0) continue;

    if (status.status === "Bomb") {
      events.push(...removeStatusInstance(state, status, "detonated"));
      if (state.currentHp <= 0) continue;

      const bombDamage = Math.max(0, status.value ?? 0)
        + (status.percentPerTurn > 0 ? Math.round(state.maxHp * status.percentPerTurn) : 0);
      if (bombDamage > 0) {
        events.push(...applyDamage(state, bombDamage, {
          sourceId: status.sourceId ?? null,
          skillId: null,
          kind: "bomb",
          canBreakSleep: true,
        }));
      }

      if (state.currentHp > 0) {
        const stun = applyStatus({
          source: null,
          sourceId: status.sourceId ?? null,
          target: state,
          status: "Stun",
          duration: 1,
          skipResistance: true,
          formulas: options?.formulas ?? null,
        }, options?.rng ?? Math.random);
        events.push(...stun.events);
      }
      continue;
    }

    events.push(...removeStatusInstance(state, status, "expired"));
  }

  return { ok: events.length > 0, state, events };
}
