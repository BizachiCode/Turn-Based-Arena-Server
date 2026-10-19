import { AppError } from "../../shared/errors/app-error.js";
import { Idempotency } from "../../shared/kernel/idempotency.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { noActivity, type PlayerActivitySink } from "../../shared/kernel/activity.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { CharacterRules } from "../roster/character-grant.service.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { CharacterRepository } from "../roster/roster.ports.js";
import { AwakenError, type AwakenPreviewNeedDto, type AwakenSuccessDto, type CurrencyCostDto } from "./awakening.dto.js";

/** Thrown to abort the transaction once a preview passed every requirement. */
class PreviewAnswer extends Error {
  constructor(readonly needs: AwakenPreviewNeedDto[]) {
    super("preview");
  }
}

/** Successful preview: requirements met, nothing spent. */
export type AwakenPreviewDto = { ok: true; preview: true; needs: AwakenPreviewNeedDto[] };

export class AwakeningService {
  constructor(
    private readonly characters: CharacterRepository,
    private readonly characterRules: CharacterRules,
    private readonly ledger: WalletLedger,
    private readonly rosterCache: RosterCache,
    private readonly uow: UnitOfWork,
    /** Receives `monster_awaken` after an awakening (missions). */
    private readonly activity: PlayerActivitySink = noActivity,
    /** Stored responses of repeated `requestId`s (default: no idempotency). */
    private readonly idempotency: Idempotency = new Idempotency(null, uow),
  ) {}

  /**
   * Awakens a character one step. With `preview`, nothing is spent and a passing preview answers
   * `{ ok: true, preview: true, needs }`. A preview never uses `requestId` (it changes nothing).
   */
  async awaken(userId: string, characterUid: string, preview: boolean, requestId?: string): Promise<AwakenSuccessDto | AwakenPreviewDto> {
    const key = preview ? undefined : requestId;
    const repeated = await this.idempotency.replay<AwakenSuccessDto>(userId, key, "awaken");
    if (repeated) return repeated;

    try {
      const { value: result, replayed } = await this.idempotency.run<AwakenSuccessDto>(userId, key, "awaken", async (session) => {
        const [character] = await this.characters.lockByUids(userId, [characterUid], session);
        if (!character) throw new AppError(AwakenError.CHAR_NOT_FOUND, { fields: { preview } });

        const definition = this.characterRules.get(character.characterId);
        if (!definition) throw new AppError(AwakenError.CATALOG_NOT_FOUND, { fields: { preview } });

        const steps = Array.isArray(definition.awakenings) ? definition.awakenings : [];
        const nextIndex = character.awakeningIndex + 1;
        const step = steps[nextIndex - 1];
        if (!step) throw new AppError(AwakenError.NO_MORE_AWAKENINGS, { fields: { preview } });

        if (character.level < step.minLevel) {
          throw new AppError(AwakenError.REQUIREMENT_LEVEL, {
            fields: { requiredLevel: step.minLevel, hasLevel: character.level, preview },
          });
        }
        if (character.stars < step.minStars) {
          throw new AppError(AwakenError.REQUIREMENT_STARS, {
            fields: { requiredStars: step.minStars, hasStars: character.stars, preview },
          });
        }

        // Merge duplicate currency entries of the step before checking/charging.
        const merged = new Map<string, number>();
        for (const cost of step.costs ?? []) {
          const amount = Math.floor(Number(cost?.amount) || 0);
          if (!cost?.currencyId || amount <= 0) continue;
          merged.set(String(cost.currencyId), (merged.get(String(cost.currencyId)) ?? 0) + amount);
        }
        const costs: CurrencyCostDto[] = [...merged].map(([currencyId, amount]) => ({ currencyId, amount }));

        const balances = await this.ledger.lockedBalances(session, userId, costs.map((cost) => cost.currencyId));
        const needs: AwakenPreviewNeedDto[] = costs.map((cost) => {
          const have = balances[cost.currencyId] ?? 0;
          return { currencyId: cost.currencyId, need: cost.amount, have, missing: Math.max(0, cost.amount - have) };
        });

        const missing = needs.filter((need) => need.missing > 0);
        if (missing.length > 0) throw new AppError(AwakenError.INSUFFICIENT_CURRENCY, { fields: { missing, preview } });
        if (preview) throw new PreviewAnswer(needs);

        const walletAfter = await this.ledger.debit(session, userId, costs);
        await this.characters.updateAwakening(userId, characterUid, nextIndex, session);

        return {
          ok: true as const,
          instance: {
            uid: character.uid,
            characterId: character.characterId,
            stars: character.stars,
            level: character.level,
            currentExp: character.currentExp,
            awakeningIndex: nextIndex,
            awakened: nextIndex > 0,
            skillLevels: character.skillLevels,
          },
          walletAfter,
          wallet: await this.ledger.snapshot(userId, session),
          consumed: costs,
        };
      });

      if (!replayed) {
        await this.rosterCache.invalidate(userId);
        await this.activity.record(userId, "monster_awaken");
      }
      return result;
    } catch (error) {
      if (error instanceof PreviewAnswer) return { ok: true, preview: true, needs: error.needs };
      throw error;
    }
  }
}
