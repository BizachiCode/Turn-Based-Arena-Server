// Daily account purge: hard-deletes accounts whose deletion grace period is over (account room `request_deletion`).

import { createLogger } from "../../shared/logger.js";

const logger = createLogger("AccountPurgeJob");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Port implemented by `AccountService`. */
export interface AccountPurger {
  /** Deletes every account past its deletion_scheduled_at; returns how many were removed. */
  purgeDueAccounts(): Promise<number>;
}

export class AccountPurgeJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly purger: AccountPurger) {}

  /** Runs once a day at `hour:minute` (server local time). */
  schedule(hour = 4, minute = 17): void {
    const now = new Date();
    const first = new Date(now);
    first.setHours(hour, minute, 0, 0);
    if (first.getTime() <= now.getTime()) first.setDate(first.getDate() + 1);

    this.timer = setTimeout(() => {
      void this.runSafely();
      this.timer = setInterval(() => void this.runSafely(), DAY_MS);
    }, first.getTime() - now.getTime());
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runSafely(): Promise<number> {
    try {
      const purged = await this.run();
      logger.info(`purge done: ${purged} account(s) deleted`);
      return purged;
    } catch (error) {
      logger.error("run failed:", error);
      return 0;
    }
  }

  run(): Promise<number> {
    return this.purger.purgeDueAccounts();
  }
}
