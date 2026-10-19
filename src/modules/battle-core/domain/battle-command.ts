export const BATTLE_COMMAND_TYPES = [
  "start_turn",
  "use_skill",
  "end_turn",
  "surrender",
] as const;

export type BattleCommandType = typeof BATTLE_COMMAND_TYPES[number];

export type StartTurnCommand = {
  type: "start_turn";
  actorId: string;
};

export type UseSkillCommand = {
  type: "use_skill";
  actorId: string;
  skillId: string;
  targetId: string;
};

export type EndTurnCommand = {
  type: "end_turn";
  actorId: string;
  reason?: "manual" | "timeout" | "control" | "no_action";
};

export type SurrenderCommand = {
  type: "surrender";
  sideId: string;
  actorId?: string;
};

export type BattleCommand =
  | StartTurnCommand
  | UseSkillCommand
  | EndTurnCommand
  | SurrenderCommand;
