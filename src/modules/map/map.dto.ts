import type { StageDifficulty } from "../../shared/kernel/types.js";

export type StageStartRequestDto = {
  regionId: string;
  stageId: string;
  difficulty: StageDifficulty;
  uidsInSlots: string[];
  leaderSlotIndex: number;
  /** Client idempotency key: a repeated id returns the first response (same ticket) without charging again. */
  requestId?: string;
};

/** `stage/validateStart` success body (errors are `{ ok: false, code, message }`). */
export type StageStartResponseDto = {
  ok: true;
  sceneName: string;
  currencyId: string;
  energySpent: number;
  wallet: Record<string, number>;
  /** Ticket consumed by `battle_start` (optional there; the newest matching ticket is used). */
  ticketId: string;
  /** Present (true) when this is the stored response of a repeated `requestId`. */
  replayed?: true;
};
