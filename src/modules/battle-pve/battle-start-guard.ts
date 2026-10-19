// Serializes `battle_start` / `battle_start_arena` inside one battle room: only one start may be in flight, and a
// start is refused while the room's current session is still running (two concurrent starts would otherwise consume
// two tickets and orphan the first battle).

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";

export class BattleStartGuard {
  private starting = false;

  /**
   * Runs `begin` (build + register the session) when no start is in flight and `current` is absent or finished;
   * rejects with BATTLE_IN_PROGRESS otherwise. The in-flight flag is released when `begin` settles.
   */
  async run<T>(current: { readonly finished: boolean } | null | undefined, begin: () => Promise<T>): Promise<T> {
    if (this.starting || (current && !current.finished)) throw new AppError(ErrorCode.BATTLE_IN_PROGRESS);
    this.starting = true;
    try {
      return await begin();
    } finally {
      this.starting = false;
    }
  }
}
