import type { BattleStatusEvent } from "../statuses/status-models";
import type { PassiveTriggerId } from "../types/battle-data";
import type { BattleMode, BattlePhase } from "./battle-state";
import type { BattleCommandType } from "./battle-command";

export type BattleFinishReason =
  | "elimination"
  | "surrender"
  | "turn_limit"
  | "scripted"
  | "draw";

export type BattleTurnEndReason =
  | "manual"
  | "timeout"
  | "control"
  | "no_action"
  | "skill_resolved"
  | "died";

export type BattleSkillTrigger = "turn_action" | "counterattack" | "additional_attack" | "ally_attack";

/**
 * Engine events. Every event is a flat JSON object with a `type` discriminator; the full contract (all
 * fields, ordering inside a turn) is documented in `docs/BATTLE_EVENTS.md`.
 */
export type BattleEngineEvent =
  | {
      type: "battle_started";
      battleId: string;
      mode: BattleMode;
      rulesetId: string;
    }
  | {
      type: "phase_changed";
      battleId: string;
      phase: BattlePhase;
    }
  | {
      type: "turn_started";
      battleId: string;
      actorId: string;
      sideId: string;
      turn: number;
      round: number;
    }
  | {
      type: "passive_triggered";
      battleId: string;
      ownerId: string;
      passiveId: string;
      trigger: PassiveTriggerId;
      targetIds: string[];
      /** Trigger cooldown set by this fire (only for triggers with a cooldown). */
      cooldown?: number;
      /** Fires left this battle (only for triggers with `maxPerBattle`). */
      remainingUses?: number;
    }
  | {
      type: "turn_skipped";
      battleId: string;
      actorId: string;
      reason: "control" | "no_action" | "died";
    }
  | {
      type: "skill_used";
      battleId: string;
      actorId: string;
      targetIds: string[];
      skillId: string;
      skillLevel: number;
      primaryTargetId?: string;
      trigger?: BattleSkillTrigger;
    }
  | {
      type: "turn_ended";
      battleId: string;
      actorId: string;
      reason: BattleTurnEndReason;
    }
  | {
      type: "extra_turn_granted";
      battleId: string;
      actorId: string;
      /** `rune_set` (Violent), `skill` (ExtraTurn effect of `skillId`) or `passive` (ExtraTurn effect of `passiveId`). */
      source: "rune_set" | "skill" | "passive";
      skillId?: string;
      passiveId?: string;
    }
  | {
      type: "additional_attack_triggered";
      battleId: string;
      actorId: string;
      targetId: string;
      skillId: string;
    }
  | {
      type: "ally_attack_triggered";
      battleId: string;
      actorId: string;
      sourceId: string;
      targetId: string;
      skillId: string;
    }
  | {
      type: "counterattack_triggered";
      battleId: string;
      actorId: string;
      targetId: string;
      skillId: string;
    }
  | {
      type: "battle_finished";
      battleId: string;
      winnerSideId: string | null;
      reason: BattleFinishReason;
      turn?: number;
    }
  | {
      type: "wave_cleared";
      battleId: string;
      waveIndex: number;
      sideId: string;
      removedUnitIds?: string[];
    }
  | {
      type: "wave_started";
      battleId: string;
      waveIndex: number;
      totalWaves: number;
      spawnedUnitIds: string[];
    }
  | {
      type: "command_rejected";
      battleId: string;
      commandType: BattleCommandType;
      reason: string;
    }
  | {
      /** Round modes (SpeedRounds, AlternatingSides, TeamPhase): a new round begins. */
      type: "round_started";
      battleId: string;
      round: number;
    }
  | {
      /** TeamPhase: `sideId` starts acting (after `round_started` when the phase opens a round). */
      type: "team_phase_started";
      battleId: string;
      sideId: string;
      round: number;
    }
  | {
      /**
       * Round modes: upcoming actors (emitted before every turn start and when the session waits for the player to
       * pick a unit). `actorIds` = the actions left in the current round (TeamPhase: phase), in order;
       * `nextActorIds` = the predicted order of the next round (TeamPhase: the next phase's side).
       */
      type: "turn_order";
      battleId: string;
      round: number;
      sideId: string | null;
      actorIds: string[];
      nextActorIds: string[];
    };

export type BattleEvent = BattleEngineEvent | BattleStatusEvent;
