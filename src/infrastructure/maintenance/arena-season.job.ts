// Arena season sweep: settles the ended season of players who don't open the arena again (reward mail + soft reset),
// so the ranking only shows current-season ratings. Players who come back are settled lazily anyway.

import { createLogger } from "../../shared/logger.js";

const logger = createLogger("ArenaSeasonJob");
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** Port implemented by `ArenaSeasonService`. */
export interface ArenaSeasonSweeper {
  /** Settles every profile still in an ended season; returns how many were settled. */
  settleOutdatedProfiles(): Promise<number>;
}

export class ArenaSeasonJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly sweeper: ArenaSeasonSweeper) {}

  /** Runs every `intervalMs` (default 10 minutes): a season end is settled within one interval. */
  schedule(intervalMs = DEFAULT_INTERVAL_MS): void {
    this.stop();
    this.timer = setInterval(() => void this.runSafely(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runSafely(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const settled = await this.sweeper.settleOutdatedProfiles();
      if (settled > 0) logger.info(`season sweep: ${settled} profile(s) settled`);
      return settled;
    } catch (error) {
      logger.error("run failed:", error);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
