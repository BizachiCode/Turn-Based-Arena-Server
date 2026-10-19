// Wire shapes of the `story` room (docs/PROTOCOL.md `story`; Unity `StoryDTOs.cs`).

import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { ShopGrantsDto } from "../shop/shop.dto.js";

export type StoryCompletionDto = { dialogueId: string; skipped: boolean; times: number; completedAt: string };

/** `story/state` and the response of `story/progress` / `story/clear`. */
export type StoryStateDto = {
  ok: true;
  serverTime: string;
  completed: StoryCompletionDto[];
  /** The sequence in progress (resume it from `step`), or null. */
  active: { dialogueId: string; step: number } | null;
};

/** `story/complete`: the state plus what the first completion granted. */
export type StoryCompleteDto = StoryStateDto & {
  dialogueId: string;
  /** False when the sequence was already completed (nothing granted). */
  firstTime: boolean;
  grants: ShopGrantsDto;
  /** Balances after the grant (null when nothing was granted). */
  wallet: WalletSnapshot | null;
};
