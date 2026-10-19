import type {
  BattleRuntimeBattleStartedContext,
  BattleRuntimeEffectBundleRequest,
  BattleRuntimeSkillResolvedContext,
  BattleRuntimeSkillStartingContext,
  BattleRuntimeSystem,
  BattleRuntimeTurnEndingContext,
  BattleRuntimeTurnStartedContext,
  BattleRuntimeUnitDiedContext,
} from "../application/battle-runtime-system";
import { findLowestHpAlly, pickRandomUnits } from "../application/targeting-resolver";
import type { BattleRandom } from "../domain/battle-random";
import type { BattleState, BattleUnitState } from "../domain/battle-state";
import type { BattleEvent } from "../domain/battle-event";
import { getBattleUnit, listAliveEnemyUnits, listBattleUnits, listUnitsBySide } from "../domain/battle-state-utils";
import { rollChance } from "../effects/combat-effect-math";
import { buildStatusSummary } from "../statuses/status-rules";
import type { CharacterPassiveDTO, CharacterPassiveTriggerDTO, PassiveTriggerId } from "../types/battle-data";

type PassiveContext = {
  state: BattleState;
  rng: BattleRandom;
  resolveEffectBundle(request: BattleRuntimeEffectBundleRequest): BattleEvent[];
};

function readUnitPassives(unit: BattleUnitState): CharacterPassiveDTO[] {
  return Array.isArray(unit.passives) ? unit.passives : [];
}

function resolvePassiveTargets(
  context: PassiveContext,
  owner: BattleUnitState,
  primaryTarget: BattleUnitState,
  trigger: CharacterPassiveTriggerDTO
): BattleUnitState[] {
  const state = context.state;
  const revives = trigger.effects.some((effect) => effect.type === "Revive");

  switch (trigger.target) {
    case "AllAllies":
      return listUnitsBySide(state, owner.sideId).filter((unit) => unit.currentHp > 0 || revives);

    case "AllEnemies":
      return listAliveEnemyUnits(state, owner.sideId);

    case "PrimaryTarget":
    case "Attacker":
      return [primaryTarget];

    case "LowestHpAlly": {
      const lowest = findLowestHpAlly(state, owner);
      return lowest ? [lowest] : [];
    }

    case "RandomEnemy":
      return pickRandomUnits(listAliveEnemyUnits(state, owner.sideId), 1, context.rng);

    case "Self":
    default:
      return [owner];
  }
}

/** Unit metadata key: turns left before a passive trigger can fire again, by `<passiveId>#<trigger index>`. */
export const PASSIVE_COOLDOWNS_METADATA_KEY = "passiveCooldowns";
/** Unit metadata key: times a passive trigger fired in the battle, by `<passiveId>#<trigger index>`. */
export const PASSIVE_USES_METADATA_KEY = "passiveUses";

/**
 * Triggers fired during the current action (one engine dispatch = one cloned state): a trigger fires at most once per
 * bearer per action, whatever the data (stops death / revive ping-pong).
 */
const firedThisAction = new WeakMap<BattleState, Set<string>>();

function counterMap(owner: BattleUnitState, key: string): Record<string, number> {
  const metadata = owner.metadata ?? (owner.metadata = {});
  const raw = metadata[key];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, number>;
  const created: Record<string, number> = {};
  metadata[key] = created;
  return created;
}

function readCounter(owner: BattleUnitState, key: string, triggerKey: string): number {
  const raw = (owner.metadata?.[key] as Record<string, unknown> | undefined)?.[triggerKey];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function triggerCooldown(trigger: CharacterPassiveTriggerDTO): number {
  return Math.max(0, Math.floor(Number(trigger.cooldown ?? 0) || 0));
}

function triggerMaxPerBattle(trigger: CharacterPassiveTriggerDTO): number {
  return Math.max(0, Math.floor(Number(trigger.maxPerBattle ?? 0) || 0));
}

/**
 * Passive trigger cooldowns tick like skill cooldowns: -1 at the end of each of the bearer's own turns (not when it
 * died during the turn; dead units take no turns).
 */
function tickPassiveCooldowns(owner: BattleUnitState): void {
  const raw = owner.metadata?.[PASSIVE_COOLDOWNS_METADATA_KEY];
  if (!raw || typeof raw !== "object") return;
  const cooldowns = raw as Record<string, number>;
  for (const key of Object.keys(cooldowns)) {
    if (cooldowns[key] > 0) cooldowns[key] -= 1;
  }
}

function executePassiveTrigger(
  context: PassiveContext,
  owner: BattleUnitState,
  passive: CharacterPassiveDTO,
  trigger: CharacterPassiveTriggerDTO,
  triggerIndex: number,
  primaryTarget: BattleUnitState
): BattleEvent[] {
  if (!Array.isArray(trigger.effects) || trigger.effects.length === 0) return [];

  const triggerKey = `${passive.id}#${triggerIndex}`;
  const actionKey = `${owner.unitId}|${triggerKey}`;
  let fired = firedThisAction.get(context.state);
  if (!fired) {
    fired = new Set<string>();
    firedThisAction.set(context.state, fired);
  }
  if (fired.has(actionKey)) return [];

  const cooldown = triggerCooldown(trigger);
  const maxPerBattle = triggerMaxPerBattle(trigger);
  if (cooldown > 0 && readCounter(owner, PASSIVE_COOLDOWNS_METADATA_KEY, triggerKey) > 0) return [];
  if (maxPerBattle > 0 && readCounter(owner, PASSIVE_USES_METADATA_KEY, triggerKey) >= maxPerBattle) return [];

  if (!rollChance(trigger.chance ?? 1, () => context.rng.next())) return [];

  const targets = resolvePassiveTargets(context, owner, primaryTarget, trigger);
  if (targets.length === 0) return [];

  fired.add(actionKey);
  if (cooldown > 0) counterMap(owner, PASSIVE_COOLDOWNS_METADATA_KEY)[triggerKey] = cooldown;
  let remainingUses: number | undefined;
  if (maxPerBattle > 0) {
    const uses = counterMap(owner, PASSIVE_USES_METADATA_KEY);
    uses[triggerKey] = readCounter(owner, PASSIVE_USES_METADATA_KEY, triggerKey) + 1;
    remainingUses = maxPerBattle - uses[triggerKey];
  }

  return [
    {
      type: "passive_triggered",
      battleId: context.state.battleId,
      ownerId: owner.unitId,
      passiveId: passive.id,
      trigger: trigger.trigger,
      targetIds: targets.map((target) => target.unitId),
      ...(cooldown > 0 ? { cooldown } : {}),
      ...(remainingUses !== undefined ? { remainingUses } : {}),
    },
    ...context.resolveEffectBundle({
      actor: owner,
      primaryTarget: targets[0],
      targets,
      sourceId: passive.id,
      sourceName: passive.name ?? passive.id,
      effects: trigger.effects,
      passiveId: passive.id,
      conditionTarget: primaryTarget,
    }),
  ];
}

/** Runs every passive trigger of `owner` matching `triggerId`, unless the owner has Oblivion. */
function executeMatchingTriggers(
  context: PassiveContext,
  owner: BattleUnitState,
  primaryTarget: BattleUnitState,
  triggerId: PassiveTriggerId
): BattleEvent[] {
  if (buildStatusSummary(owner).passivesSealed) return [];

  const events: BattleEvent[] = [];
  for (const passive of readUnitPassives(owner)) {
    const triggers = Array.isArray(passive.triggers) ? passive.triggers : [];
    triggers.forEach((trigger, index) => {
      if (trigger.trigger !== triggerId) return;
      events.push(...executePassiveTrigger(context, owner, passive, trigger, index, primaryTarget));
    });
  }
  return events;
}

/** OnDeath of the dead unit, then OnAllyDeath of every living ally (canonical order). */
function executeDeathTriggers(context: PassiveContext, unit: BattleUnitState, killer: BattleUnitState): BattleEvent[] {
  const events = executeMatchingTriggers(context, unit, killer, "OnDeath");
  for (const ally of listUnitsBySide(context.state, unit.sideId)) {
    if (ally.unitId === unit.unitId || ally.currentHp <= 0) continue;
    events.push(...executeMatchingTriggers(context, ally, killer, "OnAllyDeath"));
  }
  return events;
}

/**
 * Data-driven passive triggers: OnBattleStart, OnTurnStart (after continuous damage), BeforeAttack (the owner starts a
 * skill, before its effects; primary target = the skill's), OnAttack (after the owner's skill), OnCrit (the owner's
 * skill landed a critical hit), OnKill (the owner's skill killed an enemy), OnDamaged (owner hit by an attack and still
 * alive), OnCritReceived (owner hit by a critical hit; Attacker = the hitter), OnHealed (a skill effect restored HP of
 * the owner), OnDebuffed (a harmful status landed on the owner), OnDeath (owner died; also for deaths outside skills),
 * OnAllyDeath (an ally of the owner died) and OnTurnEnd (the owner's turn ends). Oblivion disables every trigger of
 * its bearer (its counters are kept). A trigger with `cooldown` cannot fire again until the bearer took that many of its
 * own turns (ticked at the end of each of its turns, the firing turn included, like skill cooldowns; dead units take no
 * turns); `maxPerBattle` caps the fires per battle; and any trigger fires at most once per bearer per action.
 * Counters live in the bearer's `metadata.passiveCooldowns` / `metadata.passiveUses`.
 */
export class PassiveRuntimeSystem implements BattleRuntimeSystem {
  readonly id = "passive-runtime-system";

  onBattleStarted(context: BattleRuntimeBattleStartedContext): BattleEvent[] {
    const events: BattleEvent[] = [];
    for (const unit of listBattleUnits(context.state)) {
      if (unit.currentHp <= 0) continue;
      events.push(...executeMatchingTriggers(context, unit, unit, "OnBattleStart"));
    }
    return events;
  }

  onTurnStarted(context: BattleRuntimeTurnStartedContext): BattleEvent[] {
    if (context.actor.currentHp <= 0) return [];
    return executeMatchingTriggers(context, context.actor, context.actor, "OnTurnStart");
  }

  onSkillStarting(context: BattleRuntimeSkillStartingContext): BattleEvent[] {
    if (context.actor.currentHp <= 0) return [];
    return executeMatchingTriggers(context, context.actor, context.primaryTarget, "BeforeAttack");
  }

  onSkillResolved(context: BattleRuntimeSkillResolvedContext): BattleEvent[] {
    const events: BattleEvent[] = [];
    const actor = context.actor;

    if (actor.currentHp > 0) {
      events.push(...executeMatchingTriggers(context, actor, context.primaryTarget, "OnAttack"));

      const crit = context.effectEvents.find((event) =>
        event.type === "damage_applied" && event.kind === "attack" && event.sourceId === actor.unitId && !!event.isCritical);
      if (crit && crit.type === "damage_applied") {
        events.push(...executeMatchingTriggers(context, actor, getBattleUnit(context.state, crit.targetId) ?? context.primaryTarget, "OnCrit"));
      }

      const kill = context.effectEvents.find((event) => {
        if (event.type !== "unit_died" || event.sourceId !== actor.unitId) return false;
        const victim = getBattleUnit(context.state, event.targetId);
        return !!victim && victim.sideId !== actor.sideId;
      });
      if (kill && kill.type === "unit_died" && actor.currentHp > 0) {
        events.push(...executeMatchingTriggers(context, actor, getBattleUnit(context.state, kill.targetId) ?? context.primaryTarget, "OnKill"));
      }
    }

    const damaged = new Set<string>();
    const critted = new Set<string>();
    const debuffed = new Set<string>();
    const healed = new Set<string>();
    const dead = new Set<string>();
    for (const event of context.effectEvents) {
      if (event.type === "damage_applied" && event.kind === "attack") {
        const unit = getBattleUnit(context.state, event.targetId);
        const attacker = (event.sourceId ? getBattleUnit(context.state, event.sourceId) : undefined) ?? actor;
        if (!damaged.has(event.targetId) && (event.amount + (event.absorbed ?? 0)) > 0) {
          damaged.add(event.targetId);
          if (unit && unit.currentHp > 0) events.push(...executeMatchingTriggers(context, unit, attacker, "OnDamaged"));
        }
        if (event.isCritical && !critted.has(event.targetId)) {
          critted.add(event.targetId);
          if (unit && unit.currentHp > 0) events.push(...executeMatchingTriggers(context, unit, attacker, "OnCritReceived"));
        }
      } else if (event.type === "heal_applied" && event.amount > 0) {
        if (healed.has(event.targetId)) continue;
        healed.add(event.targetId);
        const unit = getBattleUnit(context.state, event.targetId);
        if (!unit || unit.currentHp <= 0) continue;
        const healer = (event.sourceId ? getBattleUnit(context.state, event.sourceId) : undefined) ?? actor;
        events.push(...executeMatchingTriggers(context, unit, healer, "OnHealed"));
      } else if (event.type === "status_applied" && !event.isBuff) {
        if (debuffed.has(event.targetId)) continue;
        debuffed.add(event.targetId);
        const unit = getBattleUnit(context.state, event.targetId);
        if (!unit || unit.currentHp <= 0) continue;
        const source = (event.sourceId ? getBattleUnit(context.state, event.sourceId) : undefined) ?? actor;
        events.push(...executeMatchingTriggers(context, unit, source, "OnDebuffed"));
      } else if (event.type === "unit_died") {
        if (dead.has(event.targetId)) continue;
        dead.add(event.targetId);
        const unit = getBattleUnit(context.state, event.targetId);
        if (!unit) continue;
        const killer = (event.sourceId ? getBattleUnit(context.state, event.sourceId) : undefined) ?? actor;
        events.push(...executeDeathTriggers(context, unit, killer));
      }
    }

    return events;
  }

  onTurnEnding(context: BattleRuntimeTurnEndingContext): BattleEvent[] {
    if (context.actor.currentHp <= 0) return [];
    const events = executeMatchingTriggers(context, context.actor, context.actor, "OnTurnEnd");
    tickPassiveCooldowns(context.actor);
    return events;
  }

  onUnitDied(context: BattleRuntimeUnitDiedContext): BattleEvent[] {
    return executeDeathTriggers(context, context.unit, context.killer ?? context.unit);
  }
}
