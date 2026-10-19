# Battle rules

The combat rules of the template: attack-bar turn order (plus three round-based alternatives), skills with cooldowns,
buffs and debuffs, passives, runes and leader skills. The rules live in `src/modules/battle-core` (TypeScript, used by
the authoritative server) and are ported 1:1 to `Core/BattleCore` (C#, used by the Offline backend). Both produce
identical results for the same initial state and commands; the parity fixtures verify this (see the last section). Event
names and fields are in [`BATTLE_EVENTS.md`](BATTLE_EVENTS.md), the request side in [`PROTOCOL.md`](PROTOCOL.md).

## Architecture

- `BattleEngine.start(state)` / `dispatch(state, command)` are pure: the input state is cloned, the clone mutated
  and returned with the produced events. Commands: `start_turn`, `use_skill`, `end_turn`, `surrender`.
- RNG: xorshift32 seeded from `state.metadata.seed` (number, or string hashed with FNV-1a; defaults to the battle
  id). The current generator state is written to `state.metadata.rngState` after every dispatch, so a battle can be
  replayed from its initial state + commands. Tests may inject an RNG instead (`options.rng`).
- Rulesets decide validation hooks and the end of the battle (`pve-default`, `arena-default`, `boss-default`).
- Effect handlers (`Damage`, `Heal`, `Revive`, status-like effects, action effects `ExtraTurn` / `AdditionalAttack` /
  `AllyAttack`) are registered in a `BattleEffectHandlerRegistry`.
- Runtime systems react to engine phases: `RuneSetRuntimeSystem` (rune set specials) and `PassiveRuntimeSystem`
  (data-driven passive triggers). Hooks: `onBattleStarted`, `onTurnStarted`, `onSkillStarting` (before a skill's
  effects), `onSkillResolved`, `onTurnEnding` (before the end-of-turn tick), `onTurnCompleted`, `onUnitDied` (deaths
  outside skills).
- Passive auras are live: `refreshPassiveAuras` re-evaluates them at battle start, after every effect, after the
  turn-start and turn-end ticks, after out-of-skill deaths and when a wave spawns (see Passives).
- `PveBattleSession` (battle-core) drives the turn order, AI turns and waves; `BattlePveSession` (battle-pve) wires it to
  the server combat config and runtime systems. AI: `decideAiCommand` (enemies and player auto-play).
- Turn order systems (`application/turn-order-system.ts`, C# `TurnOrderSystem.cs`): the engine and the session ask the
  configured `TurnOrderSystem` (combat config `turnOrder.mode`) who is ready / acts next, how time advances, how a turn
  consumes the bar, the attack bar cap, extra turns, revives, waves and the turn-order preview.
- Ordering is deterministic and identical in both languages: units are iterated in canonical order (teams in
  `state.teams` order, then `team.unitIds` order); ids are compared ordinally (UTF-16 code units, C#
  `string.CompareOrdinal`); sorts are stable; `Math.round` is JavaScript rounding (half toward +infinity).

## Turn order

`turnOrder.mode` of the combat config picks the system (default `AttackBar`). Every mode keeps the same turn anatomy
(below): a turn starts, consumes the unit's attack bar, ticks continuous damage, may be skipped, resolves one skill and
ends with the duration / cooldown tick. Only *who* starts the next turn differs. Shared rules:

- Effective speed = `spd + baseSpd * (SpeedUp + Berserk - Slow)`.
- The turn bar is consumed (set to 0) when the turn starts, so ATB boosts received during the own turn are kept.
- A unit granted an extra turn (`metadata.extraTurnActorId`: ExtraTurn effect, Violent) acts right after the current turn
  in every mode (its bar is filled to the threshold; no round slot, side slot or player pick is used).
- Attack bar increases from effects (TurnBar increase, AbsorbTurnBar gain, Nemesis, passives) are blocked while the unit
  has Freeze; the ATB fill, round / phase bars, revive ATB and extra-turn fills are not effects and still apply.
- Ties are deterministic: attack bar, then effective speed (both with a 0.0001 epsilon), then the ordinal unit id.

### AttackBar

- Each unit has `turnBar` (0..`turnThreshold * turnBarHeadroomMultiplier`, threshold 1000, headroom 1.2).
- Between turns every living unit gains `effectiveSpeed * t` where `t` is the smallest time for a unit to reach its
  threshold; values are rounded to 3 decimals.
- Ready units (turn bar >= threshold) act by: highest turn bar, highest effective speed, ordinal unit id.
- `round` = `ceil(turn / number of units in the battle)`, at least 1; dead units still count. No round events.

### Round modes (SpeedRounds, AlternatingSides, TeamPhase)

The attack bar becomes the unit's place in the round (cap `turnOrder.roundModeTurnBarCap x threshold`, default 3), so every ATB effect keeps working with the
same data. The round state lives in `metadata.turnOrder` = `{ round, sideId, leadSideId, pending }`.

**SpeedRounds**: every living unit acts once per round.

- Round start (no unit ready): `round_started`; living units sorted by effective speed (desc, then ordinal id); the k-th of
  n gets `turnBar += threshold * (1 + (n - 1 - k) / n)` (rounded to 3 decimals) and joins `pending`.
- Ready = alive and (`pending` or turn bar >= threshold); order = turn bar desc, speed desc, id. Starting a turn removes
  the unit from `pending`. Speed changes therefore count from the next round.
- An attack bar change of `f` on a waiting unit moves it about `f * n` places (`+100%` = acts next); a decrease moves it
  back but it still acts this round (pending units act even below 100%). A unit that already acted keeps gains as a head
  start for the next round (its bar is added to the next round position) and acts again this round when it reaches
  100%; decreases on it do nothing (its bar is empty). AbsorbTurnBar takes at most what the target has (nothing from a
  unit that already acted).
- Units revived during the round leave `pending`: they act from the next round (revive ATB = head start).

**AlternatingSides**: like SpeedRounds, but the sides alternate.

- The round positions are ranked per side (`n` = the side's living units), so ATB effects reorder the side's own queue.
- The first slot of a round belongs to the side of the fastest living unit; after a regular turn the slot passes to the
  next side (`state.teams` order), stored in `metadata.turnOrder.sideId`. When the slot's side has no ready unit, the next side
  with one acts (the larger side finishes its units). Extra turns do not use a slot.

**TeamPhase**: a whole side acts, then the next side.

- Phase start: the first phase of the battle / of a wave is led by the side of the fastest unit and charges every
  living unit to `turnBar += threshold * (1 + teamPhaseSkipThreshold)` (default 0.5 = 150%); after that, when a phase
  ends (no ready unit of its side) its side is charged the same way for its next phase. Events `round_started` (when the
  leading side's phase opens a round) and `team_phase_started`.
- Ready = alive, on the phase side and turn bar >= threshold. The AI (enemies, auto-play) takes the fastest ready unit;
  in manual play the PvE session stops before the player's units act and the player picks any ready unit
  (`actorOptions`, see the session below). Ready player units that cannot act (Stun / Freeze / Sleep, no usable skill)
  take their skipped turn first.
- ATB: a unit that acted (bar 0) acts again this phase when gains bring it back to 100%; an attack bar decrease of more
  than `teamPhaseSkipThreshold` on a charged unit before it acts drops it below 100%, so it skips the phase (no turn: no
  continuous damage, duration or cooldown tick for it). Bars left over carry into the next charge.
- A unit revived outside its side's phase is charged for it; revived during its side's phase it waits for the next one.

**Waves (round modes)**: every turn bar resets to 0 as in AttackBar and a new round starts (TeamPhase: the fastest side
leads again); actions left in the interrupted round are lost.

## Phases inside a turn

1. `start_turn`: turn counter +1, `turn_started`, turn bar consumed (turn order system).
2. Continuous damage (every instance, in application order; a lethal tick ends the turn: `turn_skipped(died)`, the unit
   loses its turn even if revived by a passive), then HP regeneration.
3. Ruleset turn-start hook, then passives `OnTurnStart` (not under Oblivion).
4. Hard crowd control (Stun, Freeze, Sleep) → turn skipped (`control`). No usable skill → turn skipped (`no_action`).
5. `use_skill` (player command or AI): validation, `skill_used`, cooldown set, passives `BeforeAttack`, effects in order,
   rune set specials, passives (`OnAttack`, `OnCrit`, `OnKill`, `OnDamaged`, `OnCritReceived`, `OnHealed`, `OnDebuffed`,
   `OnDeath`, `OnAllyDeath`), ally attacks (`AllyAttack`), the additional attack (`AdditionalAttack`), counterattacks.
6. Turn end: passives `OnTurnEnd` (unit alive), every status loses 1 turn (statuses the unit applied **to itself during
   this turn** skip this tick), expired statuses are removed (Shield removes its remaining absorb, Bomb detonates),
   every skill cooldown -1, `turn_ended`, battle resolution, then, when the battle continues, the extra turn earned by
   an `ExtraTurn` effect and the turn-completed systems (Violent, not rolled when the turn already earned an extra turn).

Hard CC skips the turn but durations and cooldowns still tick. A debuff applied to a unit during its own turn by someone
else (e.g. a counterattack stun) ticks at the end of that same turn (a 1-turn stun from a counter is wasted).

## Skills

- Skill level is authoritative server-side (`unit.skillLevels`); `use_skill.skillLevel` sent by clients is ignored.
- Cooldown `N` (at the unit's skill level): after use the skill is available again `N` turns later (set to `N` on use,
  reduced by 1 at the end of each of the unit's turns, including the turn it was used). A `CooldownChange` decrease that a
  skill applies to its own caster never shortens that same skill (the skill's cooldown starts after it is used, so a
  "reset the other skills" effect does not touch it), so a self reset + `ExtraTurn` skill cannot chain itself.
- Usability: not on cooldown; **Provoke** → only the first skill, only on the provoker (while the provoker lives);
  **Silence** → only skills without a cooldown (cooldown 0 at the unit's skill level).

### Targeting

- `targetSide`: `Enemy`, `Ally`, `Self` or `Auto` (default). `Auto`: `AllEnemies`/`RandomEnemies` → Enemy,
  `AllAllies` → Ally; else from the effects using the skill targets (`SkillTargets`/`PrimaryTarget`): Revive → Ally,
  any harmful effect → Enemy, otherwise Ally; else from the other effects (all `Self` → Self, any enemy scope → Enemy,
  else Ally); a skill without effects uses its combat role (`Support`/`Recovery` → Ally, else Enemy).
- Primary target validation (server authority): must exist; Enemy → other side and alive; Ally → same side, alive unless
  the skill revives through its targets; `Self` skills always target the caster (the sent target is ignored).
  Provoked units must target the provoker. **Threat**: while a living enemy has Threat, single-target (`SingleTarget`)
  enemy skills must target a Threat bearer (`INVALID_TARGET_THREAT`; the line restriction does not apply then); area,
  random and ally skills are not affected; Provoke wins over Threat.
- `allowedLine` `FrontlineOnly` / `BacklineOnly`: the target must be in that line while its side still has a living unit
  in it. Line = `unit.line` (or `metadata.row`); units without a line never restrict targeting.
- Targeting modes: `SingleTarget` (primary), `CircleAroundTarget` / `LineFromTarget` (every unit on the primary's side;
  no geometry), `AllEnemies`, `AllAllies`, `RandomEnemies` (`randomTargetCount` distinct living enemies, RNG).

### Effects

Effects run in order. Each effect resolves its own targets:

- `target` scope: `SkillTargets` (default), `Self`, `PrimaryTarget`, `AllAllies`, `AllEnemies`, `LowestHpAlly` (lowest HP
  ratio, then lowest HP), `RandomEnemy`.
- Revive only affects dead units; every other effect only living units.
- Caster effects (`ExtraTurn`, `AdditionalAttack`, `AllyAttack`) always target the caster (scope ignored), so their
  conditions are checked against the caster (OnHit / OnCrit / OnKill = any target of the skill).
- `condition`: `Always` (default), `OnHit` (the target was hit by a previous Damage effect of this skill; for targets that
  were not attacked: any hit of the skill), `OnCrit` (same with critical hits), `OnKill` (a previous Damage effect of
  this skill killed a unit), `TargetHpBelow` (`currentHp / maxHp < conditionValue`), `CasterHpBelow` (same with the
  caster), `TargetHasDebuff` / `TargetHasNoDebuff` / `TargetHasNoBuff` (active harmful / beneficial statuses),
  `CasterHasStatus` / `TargetHasStatus` (`conditionStatus`, aliases included), `TargetIsNotBoss` (`isBoss`: boss units
  of PvE / tower waves; arena units are never bosses), `CasterStatHigher` (caster `conditionStat` >= target
  `conditionStat` x `conditionValue`; stats `Attack` / `Defense` / `Speed` = effective stats, `MaxHP`, `HpRatio`).
- Who "the target" of a condition is: the unit receiving the effect when it is an enemy of the caster; when the receiver
  is on the caster's own side (scope `Self`, `AllAllies`, `LowestHpAlly`, caster effects, `SkillTargets` of an ally
  skill) the target conditions (`TargetHpBelow`, `TargetHasDebuff` / `NoDebuff` / `NoBuff` / `Status`,
  `TargetIsNotBoss`, the target side of `CasterStatHigher`) read the skill's **primary target** (passive triggers: the
  trigger's primary target / attacker: the attacked enemy for `BeforeAttack` / `OnAttack`, the attacker for
  `OnDamaged`, the owner for `OnTurnStart` / `OnTurnEnd`). Examples: "if the enemy has no harmful effect, your crit
  rate increases" (a BeforeAttack passive on Self), "if the target's HP is below 50%, gain an extra turn".
- **Hit gating**: a harmful effect on an enemy that a previous Damage effect of the skill attacked applies only if at
  least one non-glancing hit landed (missed / Invincibility-blocked / glancing hits cannot carry harmful effects).
- `applyEverySplit` (after a Damage effect): harmful effects roll once per landed non-glancing hit, other effects once per
  landed hit on that target (non-harmful effects on targets that were not attacked count the landed hits of the skill; a
  harmful effect on an unattacked enemy applies once). Without it: once.
- Effect types: `Damage`, `Heal`, `ApplyStatus`, `Revive`, `Strip` (remove `buffCount` random dispellable buffs; 0 = all),
  `StealBuffs`, `TurnBar` (± `turnBarAmount * threshold`), `CooldownChange` (± `cooldownTurns` on `buffCount` random
  eligible skills of each target, 0 = every eligible skill; increase → skills with a cooldown, capped at the skill
  cooldown; decrease → skills on cooldown), `Cleanse` (remove `buffCount` random dispellable debuffs; 0 = all), and:
  - `AbsorbTurnBar`: removes `turnBarAmount * threshold` from the target's attack bar (at most what it has) and adds the
    removed amount to the caster (`turn_bar_absorbed`); harmful (`baseChance`, resistance, Immunity).
  - `ExtraTurn`: rolls `baseChance`; when it succeeds during the caster's own turn (skill or passive of the acting unit),
    the caster gets another turn right after this one (`metadata.pendingExtraTurn` → `extraTurnActorId` at turn end,
    `extra_turn_granted(source skill | passive)`).
  - `AdditionalAttack`: rolls `baseChance`; after the skill resolved the caster uses the same skill again (same level, no
    cooldown) on the primary target, or a random living enemy when it died. Turn actions only; never chains.
  - `AllyAttack`: rolls `baseChance`; `buffCount` random living allies (0 = all; not the caster, not hard-controlled,
    skill 1 aimed at enemies) attack the primary target (or a random living enemy) with their skill 1 right after the
    skill, before the additional attack. No cooldown is used and they cannot chain further follow-ups.
  - `TransferDebuffs`: moves up to `buffCount` random dispellable harmful effects (0 = all) from the caster to each scoped
    target, keeping remaining turns, magnitude and value (recorded as inflicted by the caster; `status_removed(transfer)`);
    harmful on enemies (`baseChance`, resistance, Immunity).
  - `ChangeStatusDuration`: adds `cooldownTurns` turns (`cooldownIncrease = false` → removes them) to every buff
    (`isBuff = true`) or debuff (`isBuff = false`) of each scoped unit (`status_duration_changed`; statuses reaching 0
    are removed with `status_removed(duration)`, a Bomb without detonating). Shortening buffs / extending debuffs is
    harmful (`baseChance` + resistance, not blocked by Immunity).
- Follow-ups (counterattacks, additional attacks, ally attacks) run `BeforeAttack` and the skill-resolved systems like a
  normal skill, set no cooldown and ignore caster effects.
- Harmful effects: Damage, Strip, StealBuffs, AbsorbTurnBar, TransferDebuffs, debuff ApplyStatus, ATB decrease, cooldown
  increase, harmful ChangeStatusDuration. On enemies they go through the resistance roll (non-status effects use
  `baseChance`, statuses use `applyChance`); Immunity blocks debuffs, ATB decrease / absorb, cooldown increase and
  TransferDebuffs (not Strip / StealBuffs / ChangeStatusDuration, which still go through the resistance roll). On allies no resistance roll is made. `irresistible` skips the
  resistance roll of the entry's harmful effects (the base chance is still rolled, Immunity still blocks).
- Status polarity is inherent to the status id (the authored `isBuff` flag is informational, except for
  ChangeStatusDuration where it selects buffs or debuffs).

## Damage

Per hit (Damage effects are resolved hit-major: hit 1 on every target, then hit 2, …; hits on dead targets are lost; the
effect stops if the attacker dies, e.g. from reflected damage):

1. Invincibility → `attack_missed(invulnerable)`.
2. Hit roll: `clamp(baseHitChance + (ACC - EVA) * accuracyVsEvasionWeight, minimumHitChance, maximumHitChance)`
   (default base 1: no misses unless the target has Evasion) → `attack_missed(evasion)`.
3. Element relation, from `elements.matrix` (shipped config: fire > ground > water > fire, light <-> dark). Without a
   matrix the built-in cycle applies: fire > wind > water > fire, light <-> dark.
4. Glancing chance = attacker Glancing debuff (+50%) + disadvantage chance (50%); no roll with `noGlancing`.
5. Critical chance = `CR + CritRateUp (+30%) + 15% (advantage) - 15% (disadvantage) - target CritResistUp (50%)`;
   glancing hits cannot crit unless `allowCriticalOnGlancing`; `guaranteedCrit` makes every non-glancing hit critical
   without a roll.
6. Crushing: a non-critical, non-glancing hit with advantage is crushing with `crushingChanceOnElementAdvantage` (100%).
7. Damage = `(sum(term) + flatDamageBonus) * scaling * C / (C + DEF * (1 - ignoreDefense)) * Brand * DamageReduction
   * elementMultiplier * glancing(0.7) * crushing(1.3) * critical`, rounded, at least `minimumDamage`.
   - Terms: `stat * multiplier`; `Attack` / `Defense` / `Speed` / `MaxHP` read the attacker (effective stats: stat +
     base * modifier), `TargetMaxHP` / `TargetSpeed` read the unit hit.
   - `scaling` (per hit, with `scalingAmount` = a): `TargetHpLow` 1 + a(1 − target HP ratio), `TargetHpHigh`
     1 + a·target HP ratio, `CasterHpLow` / `CasterHpHigh` the same with the caster, `TargetDebuffCount` 1 + a·harmful
     status instances on the target, `CasterBuffCount` 1 + a·beneficial status instances on the caster, `CasterSpeed`
     1 + a·caster effective SPD / 100.
   - `C` = effect `defenseConstant` or `defaultDefenseConstant` (100); `ignoreDefense` (0..1) ignores that part of DEF.
   - Brand ×(1 + magnitude), DamageReduction ×(1 − magnitude) on the target.
   - Critical multiplier = `max(1, cd + CritDamageUp + critDamageBonus)` when `useCriticalDamageStat`, else
     `max(1, critMultiplier + CritDamageUp + critDamageBonus)`.
8. Damage pipeline on the target: shields absorb first (Shield statuses, then the innate shield), Endure keeps the unit at
   1 HP, HP loss, Sleep breaks on a hit, death (`unit_died`; every status except Unrevivable, shield and turn bar cleared).
9. Destroy (`destroyMaxHp`): the target's max HP drops by `round(HP damage of the hit * destroyMaxHp)`
   (`max_hp_changed(kind destroy)`); over the battle at most `damage.destroyMaxHpCap` (default 0.6) of its original
   max HP can be destroyed (`metadata.destroyedMaxHp`, shared with the Destroy rune set).
10. ReflectDamage on the target returns `round(HP damage * reflect%)` to the attacker (`kind: reflect`, not reflected again).

After all hits of the effect, `lifeSteal` heals the living caster `round(HP damage dealt to enemies * lifeSteal)`
(`heal_applied(kind lifesteal)`; HealBlock → `heal_blocked`).

Continuous damage, bombs and reflected damage are blocked by Invincibility, absorbed by shields and stopped by Endure.
Skill hits and bomb detonations wake Sleep; continuous damage and reflected damage do not.

## Healing and revive

- Heal = `stat(basis) * healScale + flatHealBonus` (basis = caster if `healFromSource`, else target), rounded, at least
  `minimumHeal`; capped at missing HP (`overheal` reports the rest). HealBlock/Unrecoverable → `heal_blocked`.
- Revive: dead target back with `round(maxHp * reviveHpPercent)` (min 1), cleansing debuffs (`cleanseDebuffsOnRevive`),
  innate shield `maxHp * shieldPercentOnRevive`, ATB `threshold * turnBarPercentOnRevive`. Cooldowns are kept. A dead unit
  with Unrevivable cannot be revived (skills or passives, `revive_blocked(UNREVIVABLE)`); dead units take no turns, so
  an Unrevivable that was on the unit when it died lasts for the rest of the battle.

## Debuff resistance

`accuracy.debuffResistanceModel`:

- `resist_floor` (default): roll the base chance (skipped at 100%); then the target resists with
  `clamp(max(minimumResistChance (0.15), RES - ACC), 0, maximumResistChance (1))`. A failed base roll emits nothing; a
  resist emits `status_blocked(RESISTED)` / `effect_resisted(RESISTED)`.
- `linear`: one roll against `clamp(base + (ACC - RES) * accuracyVsResistanceWeight, minimumDebuffChance,
  maximumDebuffChance)`.
- `irresistible` effects (both models): only the base chance is rolled (skipped at 100%).

## Statuses

Application: dead targets and duration <= 0 are rejected; Immunity blocks debuffs, InabilityImmunity blocks Stun / Freeze /
Sleep, BeneficialBlock blocks buffs; then the resistance roll for debuffs from enemies. Magnitude/percent authored as 0
use `statusDefaults`. Aliases are stored and reported as their canonical status (`Unrecoverable` → `HealBlock`; checks
such as `hasStatus` / `TargetHasStatus` accept both ids).

| Status | Effect | Default (`statusDefaults`) |
|---|---|---|
| AttackUp / AttackBreak | ATK ± base ATK * magnitude (additive) | 0.5 / 0.5 |
| DefenseUp / DefenseBreak | DEF ± base DEF * magnitude | 0.7 / 0.7 |
| SpeedUp / Slow | SPD ± base SPD * magnitude | 0.3 / 0.3 |
| CritRateUp | crit rate + magnitude | 0.3 |
| CritDamageUp | crit multiplier + magnitude | 0.3 |
| Brand | damage taken * (1 + magnitude) | 0.25 |
| Glancing | attacker glancing chance + magnitude | 0.5 |
| ContinuousDamage | `maxHp * percentPerTurn` per instance at turn start; independent instances | 5%, max 10 instances |
| HpRegen | heals `maxHp * percentPerTurn` at turn start | 15% |
| Stun / Freeze / Sleep | turn skipped; Sleep removed by a hit; Freeze also blocks attack bar increases from effects | |
| Silence | only cooldown-free skills | |
| Oblivion | passive triggers disabled; statuses granted by the bearer's own passives suppressed | |
| Provoke | first skill on the provoker only (AI and commands) | |
| Bomb | independent instances; on expiry (end of the bearer's turn) deals its value and stuns 1 turn (Immunity blocks the stun); value = `round(caster effective ATK * magnitude * C/(C+DEF))` at application | 1.5, max 5 instances |
| Shield | absorbs its value; value = magnitude * caster max HP (magnitude > 1 = flat); a new Shield keeps the larger value; expiry / strip removes the remaining value | 0.15 |
| Immunity | debuffs, ATB decrease and cooldown increase blocked | |
| Invincibility | every hit and damage blocked | |
| Endure | cannot drop below 1 HP for the whole duration (not consumed); magnitude > 0 = number of charges | |
| Counterattack | counters attacks with the first skill (chance = magnitude) | 1.0 |
| ReflectDamage | reflects magnitude * HP damage taken from hits | 0.3 |
| HealBlock (alias Unrecoverable) | no healing (skills, regen, lifesteal) | |
| BeneficialBlock | no buff can be applied | |
| DamageReduction | damage taken * (1 - magnitude) | 0.3 |
| CritResistUp | attackers' crit rate - magnitude | 0.5 |
| Threat | enemy single-target skills must target a Threat bearer | |
| Unrevivable | cannot be revived; kept on death | |
| Berserk | AttackUp + SpeedUp: ATK + base ATK * magnitude, SPD + base SPD * value; unauthored = the AttackUp / SpeedUp defaults | |
| InabilityImmunity | Stun, Freeze and Sleep blocked (`status_blocked(IMMUNITY)`) | |

Refreshing an existing (non-instance) status keeps the longest duration and the highest magnitude. Every status applied
by a skill or passive is dispellable (Strip, Cleanse and StealBuffs can remove it).

## Counterattacks

After a turn action, every enemy hit by it counters once (in hit order) when alive and not hard-controlled, if its first
skill targets enemies and it rolls its Counterattack buff chance or, failing that, its rune counter chance (Revenge).
Counters use the first skill on the attacker, trigger passives and rune effects, but never trigger counters.

## Passives

Triggers (`CharacterPassiveDTO.triggers`):

- `OnBattleStart`, `OnTurnStart` (after continuous damage), `OnTurnEnd` (the owner's turn ends, before the status tick).
- `BeforeAttack`: the owner starts a skill (after `skill_used`, before its effects), so its effects apply to that same
  action; `PrimaryTarget` = the skill's primary target.
- `OnAttack`: after the owner's skill resolved (turn actions and follow-ups). `OnCrit`: the owner's skill landed a
  critical hit (primary = the first unit crit). `OnKill`: the owner's skill killed an enemy (primary = the first one).
- `OnDamaged` (owner hit by an attack and still alive), `OnCritReceived` (owner hit by a critical hit; `Attacker` = the
  hitter), `OnHealed` (a skill effect restored HP of the owner; primary = the healer), `OnDebuffed` (a harmful status
  landed on the owner; primary = its source).
- `OnDeath` (owner died, in a skill or from continuous damage / bomb), then `OnAllyDeath` for each living ally of the dead
  unit (primary = the killer).

Damage / heal / status reactions fire once per unit per skill, from the skill's own effect events (passive effects do not
trigger other passives). `chance`, `target` (`Self`, `AllAllies`, `AllEnemies`, `PrimaryTarget`, `Attacker`,
`LowestHpAlly`, `RandomEnemy`) and per-effect scopes apply. Oblivion disables triggers (their counters are kept).

Trigger limits (checked before the `chance` roll, so a blocked trigger consumes no RNG):

- `cooldown` (bearer turns, 0 = none): after firing, the trigger cannot fire again until the bearer took that many of its
  own turns. It ticks -1 at the end of each of the bearer's turns (after `OnTurnEnd`, the firing turn included, like
  skill cooldowns); a dead bearer takes no turns, so an OnDeath revive with cooldown 9 needs 9 turns alive after reviving.
- `maxPerBattle` (0 = unlimited): total fires in the battle (waves included).
- Safety net: within one action (one engine dispatch: a turn start, a skill with its follow-ups and counters, a turn end)
  a given trigger fires at most once per bearer, whatever the data (no death / revive ping-pong).
- Counters live in the bearer's `metadata.passiveCooldowns` / `metadata.passiveUses` (key `<passiveId>#<trigger
  index>`), so they survive serialization and replays; `passive_triggered` reports `cooldown` / `remainingUses`.

Auras (`CharacterPassiveDTO.auras`, `{ stat, percent, flat, scope, elementFilter, activeWhileAlive }`) are live: they are
re-evaluated during the battle (`refreshPassiveAuras`). An aura counts while its bearer is alive (unless
`activeWhileAlive` is false) and not under Oblivion, on the units of `scope` (`Self`, `AllAllies`, `AllEnemies`) whose
element is in `elementFilter` (empty = all). `Attack` / `Defense` / `Speed`: `round(base stat * percent) + round(flat)`;
`CritRate` / `CritDamage` / `Resistance` / `Accuracy` / `Evasion`: `percent + flat` (rates clamped 0..1, crit damage
1..5); `MaxHP`: `round(max HP without auras * percent) + round(flat)`; a living unit gains the added max HP as current
HP and keeps at most the new max HP when it drops (`max_hp_changed(kind aura)`). The unit's stats without auras are kept
in `metadata.auraBaseStats`, the HP added in `metadata.auraHp`.

Awakening upgrades (`rewards.replaceSkills` / `replacePassives`, `{ from, to }`): the upgraded skill or passive takes the
slot of the one it replaces (skill levels are stored per slot, so they carry over); `addSkillIds` / `addPassiveIds` are
appended after.

## Leader skills

Applied to the unit stats when the battle is created (percent of base stats, then flat). `modeFilter` limits a leader
skill to content: `arena`, `dungeon`, `tower` (empty = every content, Unity `LeaderScope.General`). The battle's content
mode is `arena` for arena battles, otherwise the stage region's kind (`story`, `dungeon`, `tower`).

## Rune set specials

From `unit.metadata.runeSetEffects`: Will (`startOfBattleImmunityTurns`), Violent (`extraTurnChance`, after a skill; not
rolled when the turn already earned an extra turn), Despair (`stunOnHitChance` per non-glancing hit, resisted normally),
Revenge (`counterattackChance`), Vampire (`lifestealPercent` of HP damage dealt to enemies, `heal_applied(kind
lifesteal)`), Nemesis (`atbGainPerHpLostPercent`, blocked by Freeze), Destroy (`destroyMaxHpPercentPerHit` of HP damage,
`damage.destroyMaxHpCap` battle cap shared with `destroyMaxHp`).

## End of battle

- Elimination (PvE: enemy side wiped with no pending wave → victory; player side wiped → defeat).
- `surrender` command (PvE session: `surrender()` → defeat).
- `metadata.turnLimit` (> 0): when the global turn counter reaches it after a resolved turn → draw (`winnerSideId` null,
  reason `turn_limit`). The boss ruleset keeps its own rule: at the turn limit the boss side wins while the boss lives,
  otherwise the challengers.

## Waves (PvE session)

When the enemy side is wiped and a wave is pending: dead enemies are removed from the state (`wave_cleared.removedUnitIds`),
**every turn bar resets to 0**, survivors keep their statuses, shields and cooldowns, the next wave spawns with
turn bar 0 (`wave_started`). `metadata.currentWaveIndex` / `pendingEnemyWaveCount` are updated. Round modes start a new
round (see Turn order).

## PvE session and the turn order

- Before every turn start the session asks the turn order system for the next actor (advancing time when nobody is
  ready); round modes emit `turn_order` (upcoming actors) right before the `start_turn`.
- Every step result carries `turnOrder` (`mode`, `round`, `sideId`, `actorIds`, `nextActorIds`): AttackBar = a
  simulation of the next actors (one per living unit, no state change); round modes = the actions left in the round
  (TeamPhase: phase) and the predicted next round (TeamPhase: the next phase's side).
- TeamPhase manual play: when the next actors are the player's, the session stops in `waiting_for_turn` with
  `awaitingPlayerInput`, `activeUnitId` null, `actorOptions` (action options of every ready player unit, AI order) and
  `actionOptions` = the first one. `usePlayerSkill` for any of them validates the command, starts that unit's turn and
  uses the skill (the skill is dropped when the turn start skips the unit, e.g. killed by continuous damage); a unit
  that already acted is refused with `ACTOR_NOT_READY`. `usePlayerAuto` plays the first one with the AI.
- Step budget: one step runs at most 1000 session iterations (turn starts, AI commands, wave spawns). A longer AI stretch (e.g. a data error that chains extra
  turns forever) returns `accepted: false`, `AUTO_ADVANCE_STALLED` with the battle between turns; `usePlayerAuto` then
  resumes it (it only advances the AI; a player unit is never played); the Unity presenter does this automatically.

## AI (enemies and player auto-play)

Deterministic priority (`decideAiCommand`):

1. Provoked → first skill on the provoker.
2. A dead ally without Unrevivable exists → usable revive skill on the first such ally.
3. An ally below `healThreshold` (50%) → heal skill on the lowest HP ratio ally.
4. An ally with a dispellable debuff → cleanse skill (target with the most debuffs).
5. A buff skill whose targets lack one of its buffs.
6. Attack with the highest-cooldown ready enemy skill (ties: tempo skills: ExtraTurn, AbsorbTurnBar, AdditionalAttack,
   AllyAttack, self ATB increase; then later skill slot) on the best valid target (Threat restricts the valid targets):
   the skill's preference first (AbsorbTurnBar → highest attack bar; TargetDebuffCount scaling → most debuffs;
   TargetHpHigh scaling → highest HP ratio; finishers with TargetHpLow scaling, ignoreDefense or OnKill effects → lowest
   HP ratio), then elemental advantage, lowest HP ratio, lowest HP, canonical order.
7. Any usable skill on its first valid target, else end turn.

## Combat formula snapshot

`CombatFormulaSnapshot` (server `combat_config.json`); every field is optional, `normalizeCombatFormulaSnapshot` fills
defaults:

| Section | Field | Default |
|---|---|---|
| timing | defaultTurnThreshold / turnBarHeadroomMultiplier | 1000 / 1.2 |
| turnOrder | mode (`AttackBar`, `SpeedRounds`, `AlternatingSides`, `TeamPhase`), teamPhaseSkipThreshold (0..2), roundModeTurnBarCap (1..10) | `AttackBar`, 0.5, 3 |
| accuracy | baseHitChance, accuracyVsEvasionWeight, minimumHitChance, maximumHitChance | 1, 1, 0, 1 (no misses unless the target has Evasion) |
| accuracy | debuffResistanceModel, minimumResistChance, maximumResistChance | `resist_floor`, 0.15, 1 |
| accuracy | accuracyVsResistanceWeight, minimumDebuffChance, maximumDebuffChance (`linear`) | 1, 0, 1 |
| damage | minimumDamage, defaultDefenseConstant | 1, 100 |
| damage | useCriticalDamageStat, allowCriticalOnGlancing | false, false |
| damage | glancingChanceOnElementDisadvantage, glancingDamageMultiplier | 0.5, 0.7 |
| damage | criticalRateBonusOnElementAdvantage, criticalRatePenaltyOnElementDisadvantage | 0.15, 0.15 |
| damage | crushingChanceOnElementAdvantage, crushingDamageMultiplier | 1, 1.3 |
| damage | destroyMaxHpCap (0..1, share of the original max HP Destroy can remove over a battle) | 0.6 |
| damage | elementalAdvantage/Disadvantage/NeutralDamageMultiplier | 1, 1, 1 |
| healing | minimumHeal | 1 |
| revive | cleanseDebuffsOnRevive, shieldPercentOnRevive, turnBarPercentOnRevive | true, 0, 0 |
| elements | ids, matrix (row = attacker, value > 0 advantage, < 0 disadvantage) | built-in cycle (the shipped file defines a matrix) |
| statusDefaults | per status `{ magnitude, percentPerTurn, maxStacks }` | table above (DamageReduction 0.3, CritResistUp 0.5) |

## Parity scenarios

`test/parity/parity-scenarios.ts` defines handcrafted and generated battles (every turn order mode: `turn_*` kits,
`turn_phase_selection`, `generated_rounds_*` / `generated_alternating_*` / `generated_phase_*`), and
`test/battle_parity_scenarios_test.ts` plays them in `npm test`. The Unity Offline backend runs a line-by-line C# port
of this engine (same random generator, same rounding, same unit order): after a rule change, make the same change in
the C# engine and play the rule on both backends. `npx tsx test/parity/generate-fixtures.ts [outputDir]` (default
`test/parity/fixtures`, git-ignored) records every step of these battles as JSON (events, session result, state
checkpoints; `turnOrder` / `actorOptions` and the formula's `turnOrder` section only for round-mode fixtures), for your
own comparison tools.
