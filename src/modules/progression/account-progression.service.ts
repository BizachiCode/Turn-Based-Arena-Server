// Grants account (summoner) EXP inside the caller's transaction: level ups, per-level rewards and the refill of the
// configured currencies (energy) to the new cap. Tuning comes from `config.json > gameplay.accountExp` (Unity).

import type { CurrencyAmount } from "../../shared/kernel/types.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import { capFor, mergeAmounts } from "../economy/economy.domain.js";
import type { CurrencyRules } from "../economy/economy.ports.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import { applyAccountExp, expToNextAccountLevel, type AccountExpCurve } from "./account-progression.js";

export type AccountLevelReward = { level: number; currencies: CurrencyAmount[] };

export type AccountExpConfig = AccountExpCurve & {
  /** Account EXP per energy point spent on a won stage (stages may override it). */
  expPerEnergy: number;
  levelUpRewards: AccountLevelReward[];
  /** Currencies topped up to their cap on every level up (e.g. energy). */
  refillOnLevelUp: string[];
};

/** Persistence of the account level/EXP (the profile row). */
export interface AccountProgressRepository {
  /** Locks the profile row and returns its level/EXP (null when the profile is missing). */
  lockProgress(userId: string, session: DbSession): Promise<{ level: number; currentExp: number } | null>;
  updateProgress(userId: string, level: number, currentExp: number, session: DbSession): Promise<void>;
}

/** What changed for the account (sent to the client with the battle result). */
export type AccountProgressDto = {
  expGained: number;
  level: number;
  currentExp: number;
  /** EXP needed to reach the next level (0 at max level). */
  expToNext: number;
  levelsGained: number;
  /** Level-up rewards and refills credited by this grant. */
  rewards: CurrencyAmount[];
};

export class AccountProgressionService {
  constructor(
    private readonly profiles: AccountProgressRepository,
    private readonly ledger: WalletLedger,
    private readonly currencies: CurrencyRules,
    private readonly config: () => AccountExpConfig,
  ) {}

  /** EXP for a won stage: the stage override, else energy spent x `expPerEnergy`. */
  expForStage(override: number, energySpent: number): number {
    if (override > 0) return Math.floor(override);
    return Math.max(0, Math.floor(energySpent * Math.max(0, this.config().expPerEnergy)));
  }

  async grant(session: DbSession, userId: string, exp: number): Promise<AccountProgressDto | null> {
    const current = await this.profiles.lockProgress(userId, session);
    if (!current) return null;

    const cfg = this.config();
    const result = applyAccountExp(cfg, current.level, current.currentExp, exp);
    if (result.level !== current.level || result.exp !== current.currentExp) {
      await this.profiles.updateProgress(userId, result.level, result.exp, session);
    }

    const rewards: CurrencyAmount[] = [];
    if (result.levelsGained > 0) {
      for (const level of result.reachedLevels) {
        const entry = cfg.levelUpRewards.find((reward) => reward.level === level);
        if (entry) rewards.push(...entry.currencies);
      }
      // Rewards first (caps already use the new level), then refill what is still under the cap.
      if (rewards.length > 0) await this.ledger.credit(session, userId, rewards);
      const refillIds = cfg.refillOnLevelUp.filter((id) => !!this.currencies.get(id)?.hasCap);
      if (refillIds.length > 0) {
        const balances = await this.ledger.lockedBalances(session, userId, refillIds);
        const refills: CurrencyAmount[] = [];
        for (const id of refillIds) {
          const missing = capFor(this.currencies.get(id)!, result.level) - (balances[id] ?? 0);
          if (missing > 0) refills.push({ currencyId: id, amount: missing });
        }
        if (refills.length > 0) {
          await this.ledger.credit(session, userId, refills);
          rewards.push(...refills);
        }
      }
    }

    return {
      expGained: result.expGained,
      level: result.level,
      currentExp: result.exp,
      expToNext: expToNextAccountLevel(cfg, result.level),
      levelsGained: result.levelsGained,
      rewards: [...mergeAmounts(rewards)].map(([currencyId, amount]) => ({ currencyId, amount })),
    };
  }
}
