# Battle events contract

Every battle step (an engine dispatch or a PvE session call) returns an ordered list of events: flat JSON objects
with a `type` field. Events describe what happened so that a presenter can animate it; the `state` snapshot returned
with the same step is the source of truth. The TypeScript engine (`src/modules/battle-core`) and the C# port
(`Core/BattleCore`, class `BattleEvent`) emit identical events (same `type`, field names and order), which the
cross-language parity fixtures verify. How the events reach the client is described in
[`PROTOCOL.md`](PROTOCOL.md) (`battle_pve`); the rules behind them are in [`BATTLE_RULES.md`](BATTLE_RULES.md).

## Conventions

- Field names are camelCase. Optional fields may be missing or `null`; treat both the same.
- Unit references are unit ids (`actorId`, `targetId`, `sourceId`, `ownerId`).
- Engine events carry `battleId`; unit-level (status) events do not.
- Numbers are JSON numbers. HP, damage, heal and shield values are integers; turn bars may have decimals.
- New fields may be added in the future: presenters must ignore unknown fields and unknown event types.

## Session / battle flow

| type | fields | notes |
|---|---|---|
| `battle_started` | `battleId`, `mode`, `rulesetId` | first event of `start()` (after the session's initial `wave_started`) |
| `phase_changed` | `battleId`, `phase` | `created` → `waiting_for_turn` → `awaiting_action` → `resolving_action` → … → `finished` |
| `wave_started` | `battleId`, `waveIndex` (0-based), `totalWaves`, `spawnedUnitIds[]` | emitted by the PvE session (also for wave 0 at `start()`) |
| `wave_cleared` | `battleId`, `waveIndex`, `sideId`, `removedUnitIds[]` | dead enemies of the cleared wave are removed from `state.units` |
| `battle_finished` | `battleId`, `winnerSideId` (null = draw), `reason`, `turn` | `reason`: `elimination`, `surrender`, `turn_limit`, `draw` (`scripted` is reserved and never emitted). The boss ruleset names a winner at `turn_limit`: the boss side while the boss lives, otherwise the challengers |
| `command_rejected` | `battleId`, `commandType`, `reason` | the command was not applied (state unchanged); see rejection reasons below |

## Turn flow

| type | fields | notes |
|---|---|---|
| `turn_bar_changed` | `targetId`, `amount` (applied delta), `currentTurnBar` | ATB fill (between turns), turn-start consumption (`amount` negative, `currentTurnBar` 0), ATB boosts/reductions, revive ATB, wave reset; round modes: round position / phase charge (the bar is then a place in the round, up to `turnOrder.roundModeTurnBarCap`, default 300%) |
| `round_started` | `battleId`, `round` | round modes only (`SpeedRounds`, `AlternatingSides`, `TeamPhase`): a new round begins (followed by the round's `turn_bar_changed`; TeamPhase: by the charge `turn_bar_changed` events, then `team_phase_started`) |
| `team_phase_started` | `battleId`, `sideId`, `round` | `TeamPhase` only: `sideId` starts acting (after the previous side's charge `turn_bar_changed` and the optional `round_started`) |
| `turn_order` | `battleId`, `round`, `sideId`, `actorIds[]`, `nextActorIds[]` | round modes only, emitted by the PvE session right before every `start_turn` and when it stops for the player's pick (TeamPhase). `actorIds` = actions left in the current round (TeamPhase: phase) in order, starting with the unit about to act; `nextActorIds` = predicted order of the next round (TeamPhase: units of the next phase's side). `sideId`: AlternatingSides = side of the next slot, TeamPhase = phase side, else null. Presentation only (the strip); never animate a turn from it |
| `turn_started` | `battleId`, `actorId`, `sideId`, `turn` (global counter), `round` | `round`: AttackBar `ceil(turn / units)`, round modes the current round |
| `turn_skipped` | `battleId`, `actorId`, `reason` | `control` (Stun/Freeze/Sleep), `no_action` (no usable skill), `died` (killed by continuous damage at turn start) |
| `turn_ended` | `battleId`, `actorId`, `reason` | `skill_resolved`, `control`, `no_action`, `died`, `manual`, `timeout` |
| `extra_turn_granted` | `battleId`, `actorId`, `source`, `skillId?`, `passiveId?` | `source`: `rune_set` (Violent), `skill` (ExtraTurn effect of `skillId`) or `passive` (ExtraTurn effect of `passiveId`). The unit acts next (followed by its `turn_bar_changed`) |
| `skill_used` | `battleId`, `actorId`, `skillId`, `skillLevel`, `targetIds[]`, `primaryTargetId`, `trigger` | `trigger`: `turn_action`, `counterattack`, `additional_attack` or `ally_attack`. `targetIds` = targets resolved by the skill targeting mode (per-effect scopes may add others) |
| `counterattack_triggered` | `battleId`, `actorId` (counter-attacker), `targetId`, `skillId` | followed by the counter's `skill_used` (`trigger: counterattack`) |
| `additional_attack_triggered` | `battleId`, `actorId`, `targetId`, `skillId` | AdditionalAttack: the actor uses the same skill again; followed by `skill_used` (`trigger: additional_attack`) |
| `ally_attack_triggered` | `battleId`, `actorId` (the ally), `sourceId` (unit whose skill called it), `targetId`, `skillId` | AllyAttack: followed by the ally's `skill_used` (`trigger: ally_attack`) |
| `passive_triggered` | `battleId`, `ownerId`, `passiveId`, `trigger`, `targetIds[]`, `cooldown?`, `remainingUses?` | `trigger`: `OnBattleStart`, `OnTurnStart`, `OnTurnEnd`, `BeforeAttack`, `OnAttack`, `OnCrit`, `OnKill`, `OnDamaged`, `OnCritReceived`, `OnHealed`, `OnDebuffed`, `OnDeath`, `OnAllyDeath`; `cooldown` = turns set by this fire (triggers with a cooldown), `remainingUses` = fires left this battle (triggers with `maxPerBattle`); followed by the passive's effect events |

## Combat

| type | fields | notes |
|---|---|---|
| `attack_missed` | `targetId`, `sourceId`, `skillId`, `reason`, `hitIndex`, `hitCount` | `reason`: `evasion` (miss roll) or `invulnerable` (Invincibility) |
| `damage_applied` | `targetId`, `sourceId`, `skillId`, `amount`, `currentHp`, `currentShield`, `absorbed`, `isCritical`, `isGlancing`, `isCrushing`, `elementRelation`, `hitIndex`, `hitCount`, `kind`, `endured` | one event **per hit**. `amount` = HP lost (0 when fully absorbed; may exceed the remaining HP on the killing blow), `absorbed` = shield absorbed. `elementRelation`: 1 advantage, 0 neutral, -1 disadvantage. `hitIndex` 0-based. `kind`: `attack` (skill hit), `reflect` (ReflectDamage, `sourceId` = reflecting unit, `skillId` null), `bomb` (bomb detonation). `endured`: Endure kept the unit at 1 HP |
| `periodic_damage` | `targetId`, `sourceId`, `status` (`ContinuousDamage`), `amount`, `currentHp`, `absorbed`, `endured` | continuous damage at the start of the bearer's turn (one event per instance) |
| `heal_applied` | `targetId`, `sourceId`, `skillId`, `amount` (HP actually restored), `currentHp`, `overheal`, `kind?` | skill heals, passive heals, lifesteal (`kind: lifesteal` — effect `lifeSteal` and Vampire runes; missing for other heals) |
| `periodic_heal` | `targetId`, `sourceId`, `status` (`HpRegen`), `amount`, `currentHp` | HP regeneration at turn start |
| `heal_blocked` | `targetId`, `sourceId`, `skillId` | HealBlock / Unrecoverable prevented a heal |
| `shield_changed` | `targetId`, `amount` (delta), `currentShield` | shield gained (Shield status, revive shield), absorbed, removed (expired / stripped Shield) |
| `max_hp_changed` | `targetId`, `sourceId`, `amount` (delta), `currentMaxHp`, `currentHp`, `kind` | `kind`: `destroy` (effect `destroyMaxHp`, Destroy runes; `amount` negative, `sourceId` = attacker) or `aura` (passive auras; `amount` ±, `sourceId` null) |
| `turn_bar_absorbed` | `targetId`, `sourceId`, `skillId`, `amount` | AbsorbTurnBar: `amount` attack bar points taken from the target and given to the source; followed by the target's and the source's `turn_bar_changed` |
| `unit_died` | `targetId`, `sourceId` (killer, may be null), `cause` | `cause`: `attack`, `reflect`, `bomb`, `continuous_damage`. **Implies**: every status except Unrevivable removed, shield 0, turn bar 0 (no individual events are emitted for those) |
| `unit_revived` | `targetId`, `sourceId`, `revivedHp`, `currentHp`, `grantedShield`, `currentTurnBar`, `cleansedDebuffs` | |
| `revive_blocked` | `targetId`, `sourceId`, `skillId`, `reason` (`UNREVIVABLE`) | a revive (skill or passive) failed on an Unrevivable unit |
| `cooldown_changed` | `targetId`, `skillId`, `amount` (delta), `currentCooldown` | skill used (cooldown set), end-of-turn reduction (-1), cooldown effects |

## Statuses

| type | fields | notes |
|---|---|---|
| `status_applied` | `targetId`, `sourceId`, `status`, `isBuff`, `duration` (remaining turns), `stacks`, `magnitude`, `value` | new status or refresh of an existing one. For `ContinuousDamage` / `Bomb` (independent instances) `stacks` = number of instances on the target. `value` = Shield absorb / Bomb damage |
| `status_blocked` | `targetId`, `sourceId`, `status`, `reason` | `IMMUNITY`, `BENEFICIAL_BLOCK`, `RESISTED` (resisted by RES), `MAX_STACKS`. A failed *base* chance roll emits nothing |
| `status_removed` | `targetId`, `sourceId`, `status`, `reason` | `expired`, `strip`, `steal`, `cleanse`, `damage_break` (Sleep woken by a hit), `consumed` (Shield emptied / Endure charges used), `detonated` (Bomb), `replaced` (unique tag), `transfer` (TransferDebuffs, from the caster), `duration` (ChangeStatusDuration brought it to 0) |
| `status_tick` | `targetId`, `status`, `remainingTurns`, `isBuff` | end-of-turn duration decrease (one per status instance that ticked; statuses the unit cast on itself this turn do not tick) |
| `status_duration_changed` | `targetId`, `sourceId`, `status`, `isBuff`, `amount` (± turns), `remainingTurns` | ChangeStatusDuration, one per status instance |
| `effect_resisted` | `targetId`, `sourceId`, `skillId`, `effectType`, `reason` | a harmful non-status effect (`Strip`, `StealBuffs`, ATB decrease `TurnBar`, `AbsorbTurnBar`, cooldown increase `CooldownChange`, `TransferDebuffs`, harmful `ChangeStatusDuration`) was resisted (`RESISTED`) or blocked by Immunity (`IMMUNITY`). Only `TurnBar` (decrease), `AbsorbTurnBar`, `CooldownChange` (increase) and `TransferDebuffs` report `IMMUNITY`; `Strip`, `StealBuffs` and `ChangeStatusDuration` only report `RESISTED` |

Status ids: `DefenseBreak`, `AttackBreak`, `Glancing`, `HealBlock`, `Unrecoverable`, `ContinuousDamage`, `Brand`, `Slow`,
`Stun`, `Freeze`, `Sleep`, `Silence`, `Oblivion`, `Provoke`, `Bomb`, `AttackUp`, `DefenseUp`, `Shield`, `Immunity`,
`Invincibility`, `Endure`, `SpeedUp`, `CritRateUp`, `CritDamageUp`, `Counterattack`, `ReflectDamage`, `HpRegen`,
`BeneficialBlock`, `DamageReduction`, `CritResistUp`, `Threat`, `Unrevivable`, `Berserk`, `InabilityImmunity`.
`Unrecoverable` is an alias: it is stored and reported as `HealBlock`.

## Ordering inside a step

1. Between turns (PvE session): AttackBar = `turn_bar_changed` for every unit filling its ATB; round modes = (when the
   round / phase ends) [TeamPhase: `turn_bar_changed` charge of the side that finished], [`round_started`], round
   `turn_bar_changed`, [`team_phase_started`], then `turn_order`.
2. `start_turn`: `phase_changed(awaiting_action)`, `turn_started`, `turn_bar_changed` (consumption), continuous damage
   (`periodic_damage`…, possibly `unit_died` → OnDeath / OnAllyDeath passive events → `turn_skipped(died)`),
   `periodic_heal` (or `heal_blocked` with `skillId` null while HealBlock is active), `passive_triggered(OnTurnStart)`…, then for hard CC / no usable skill: `turn_skipped` + the turn-end
   block.
3. `use_skill`: `phase_changed(resolving_action)`, `skill_used`, `cooldown_changed` (cooldown set),
   `passive_triggered(BeforeAttack)`…, effect events in effect order (per hit: `attack_missed` or [`shield_changed`]
   [`status_removed(consumed)` for an emptied Shield or a used Endure] `damage_applied` [`status_removed(damage_break)`]
   [`unit_died`, or else Destroy `max_hp_changed` when the target survived] [reflect `damage_applied`];
   after the hits of a Damage effect: life steal `heal_applied(kind lifesteal)`; aura `max_hp_changed(kind aura)` after
   any effect that changed who the auras reach), rune set events (Nemesis `turn_bar_changed`, Destroy `max_hp_changed`,
   Vampire `heal_applied`, Despair stun), passive events (`OnAttack`, `OnCrit`, `OnKill`, then per effect event
   `OnDamaged` / `OnCritReceived`, `OnHealed`, `OnDebuffed`, `OnDeath` + `OnAllyDeath`), ally attacks
   (`ally_attack_triggered`, `skill_used`, …), the additional attack (`additional_attack_triggered`, `skill_used`, …),
   counterattacks (`counterattack_triggered`, `skill_used`, …), then the turn-end block.
4. Turn-end block (when `turn_ended` has the reason `died` it shrinks to `turn_ended`, `phase_changed(waiting_for_turn)`
   and [`battle_finished`]): `passive_triggered(OnTurnEnd)`…, `status_tick`… then expirations (`status_removed`, Shield
   `shield_changed`, Bomb `status_removed(detonated)` + `damage_applied(kind bomb)` + Stun), `cooldown_changed` (-1 per
   skill on cooldown), `turn_ended`, `phase_changed(waiting_for_turn)`, [`battle_finished`] or, after a turn that ended with `skill_resolved`, [`extra_turn_granted` (`skill` or `passive`;
   when none was granted, a Violent roll gives `extra_turn_granted(rune_set)`)] followed by the actor's `turn_bar_changed`.
5. Wave transition (PvE session): `wave_cleared`, `turn_bar_changed` (reset to 0 for each living player unit whose bar was above 0), `wave_started`, aura
   `max_hp_changed(kind aura)` (round modes: then the new round's events of step 1).
6. `start()`: `battle_started`, `phase_changed(waiting_for_turn)`, aura `max_hp_changed(kind aura)`, then battle-start hooks
   (Will Immunity, `OnBattleStart` passives).

## Command rejection reasons

`BATTLE_NOT_STARTED`, `BATTLE_FINISHED`, `INVALID_PHASE`, `NOT_ACTING_UNIT`, `UNKNOWN_ACTOR`, `ACTOR_DEAD`,
`ACTOR_NOT_READY`, `UNKNOWN_SKILL`, `SKILL_ON_COOLDOWN`, `SILENCED`, `PROVOKED`, `INVALID_TARGET`,
`INVALID_TARGET_SIDE`, `TARGET_DEAD`, `INVALID_TARGET_LINE`, `INVALID_TARGET_THREAT`, `UNKNOWN_SIDE`, `BATTLE_ALREADY_STARTED` (`start()` called twice; the event reports
`commandType: start_turn`), `INVALID_COMMAND` (unknown command type) and `INVALID_RULESET_COMMAND` (the ruleset refused
without a reason).

The session returns its own reasons in `error` of the step result, without a `command_rejected` event:
`INVALID_PLAYER_ACTOR`, `NOT_AWAITING_PLAYER_INPUT`, the TeamPhase pick checks (`ACTOR_NOT_READY` when the picked unit
cannot act now, plus the skill and target reasons above), `AUTO_ADVANCE_STALLED` (the step budget ran out between turns,
or no unit became ready after 16 time advances; `usePlayerAuto` resumes) and the fallbacks `START_TURN_FAILED` and
`AI_COMMAND_REJECTED` (the engine refused an automatic start or an AI command without a reason).

## PvE session step result

Every session method (`start()`, `usePlayerSkill({actorId, skillId, targetId})`, `usePlayerAuto()`, `surrender()`)
returns:

```jsonc
{
  "accepted": true,                 // false when the command was rejected (see "error")
  "error": "PROVOKED",              // only when rejected / stalled
  "events": [ /* this contract */ ],
  "state": { /* BattleState */ },
  "phase": "awaiting_action", "turn": 12, "round": 3,
  "awaitingPlayerInput": true,
  "activeUnitId": "player-2", "activeSideId": "players",
  "currentWaveIndex": 1, "totalWaves": 3,
  "finished": false, "winnerSideId": null, "finishedReason": null,
  "victory": null,                  // true / false once finished
  "actionOptions": {                // null unless awaiting player input (TeamPhase pick: the AI's choice)
    "actorId": "player-2",
    "forcedTargetId": null,         // provoker id when provoked
    "skills": [
      { "skillId": "s1", "usable": true, "reason": null, "cooldown": 0, "targetSide": "Enemy", "targetIds": ["enemy-1", "enemy-2"] },
      { "skillId": "s3", "usable": false, "reason": "SKILL_ON_COOLDOWN", "cooldown": 2, "targetSide": "Enemy", "targetIds": [] }
    ]
  },
  "actorOptions": null,             // TeamPhase pick: [actionOptions of every ready player unit], AI order
  "turnOrder": {                    // upcoming actors (docs/BATTLE_RULES.md "Turn order")
    "mode": "SpeedRounds", "round": 3, "sideId": null,
    "actorIds": ["enemy-1", "player-3"], "nextActorIds": ["player-2", "enemy-1", "player-3", "player-1"]
  }
}
```

TeamPhase pick frames: `phase: "waiting_for_turn"`, `awaitingPlayerInput: true`, `activeUnitId` / `activeSideId` null and
`actorOptions` set; `usePlayerSkill` with any `actorOptions[].actorId` starts that unit's turn and uses the skill.

`reason` of a skill option: `SKILL_ON_COOLDOWN`, `SILENCED`, `PROVOKED`, `NO_TARGET`.
