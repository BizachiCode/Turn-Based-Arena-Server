// Grants a reward bundle (`ShopPackPayload` shape: currencies, summon scrolls, characters, runes, buildings) inside the
// caller's transaction. Shared by the shop, the mailbox and the guild quests so every reward source grants the same way.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { CurrencyAmount } from "../../shared/kernel/types.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { ShopPackPayload } from "../../config/ShopCatalog.js";
import { mergeAmounts } from "../economy/economy.domain.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { CharacterGrantService } from "../roster/character-grant.service.js";
import type { CharacterRepository } from "../roster/roster.ports.js";
import type { RuneService } from "../rune/rune.service.js";
import type { ShopCharacterDto, ShopGrantsDto } from "../shop/shop.dto.js";
import type { ConstructionInventory } from "../shop/shop.ports.js";
import { resolveSummonEconomy } from "../summon/summon.economy.js";
import type { SummonCurrencyLookup, SummonRules } from "../summon/summon.ports.js";

export type RewardGranterDeps = {
  ledger: WalletLedger;
  characters: CharacterRepository;
  characterGrants: CharacterGrantService;
  runes: RuneService;
  /** Building inventory for `constructions` rewards. */
  constructions: ConstructionInventory;
  scrolls: SummonRules;
  currencies: SummonCurrencyLookup;
};

export type GrantOptions = {
  /** `origin` stored on generated runes (e.g. "shop", "mail"). */
  runeOrigin: string;
  /**
   * Grant `constructions` too (default true). The shop plans buildings itself (forceUnique checks before charging) and
   * passes false. Here a `forceUnique` building the player already owns is skipped instead of failing the claim.
   */
  constructions?: boolean;
};

/** True when the bundle grants anything. */
export function hasRewards(payload: ShopPackPayload | null | undefined): payload is ShopPackPayload {
  if (!payload) return false;
  return payload.currencies.some((entry) => Number(entry.amount) > 0)
    || payload.scrolls.length > 0
    || payload.characters.length > 0
    || payload.runes.length > 0
    || payload.constructions.some((entry) => Number(entry.count) > 0);
}

/** Empty grants accumulator. */
export function emptyGrants(): ShopGrantsDto {
  return { currencies: [], characters: [], runes: [], constructions: [] };
}

/** Appends `extra` to `target` (currencies merged per id). */
export function mergeGrants(target: ShopGrantsDto, extra: ShopGrantsDto): void {
  target.currencies = [...mergeAmounts([...target.currencies, ...extra.currencies])].map(([currencyId, amount]) => ({ currencyId, amount }));
  target.characters.push(...extra.characters);
  target.runes.push(...extra.runes);
  target.constructions.push(...extra.constructions);
}

export class RewardGranter {
  constructor(private readonly deps: RewardGranterDeps) {}

  /**
   * Reward kinds this server cannot grant: unknown currencies, buildings or summon scrolls. Senders
   * validate bundles with it so a stored reward never fails when the player claims it.
   */
  unsupported(payload: ShopPackPayload): string[] {
    const unsupported: string[] = [];
    for (const entry of payload.currencies) {
      if (!this.deps.currencies.get(entry.currencyId)) unsupported.push(`currency:${entry.currencyId}`);
    }
    for (const entry of payload.scrolls) {
      const economy = resolveSummonEconomy(entry.scrollId, this.deps.scrolls.get(entry.scrollId), this.deps.currencies);
      if (!this.deps.currencies.get(economy.currencyId)) unsupported.push(`scroll:${entry.scrollId}`);
    }
    for (const entry of payload.constructions) {
      if (!this.deps.constructions.exists(entry.buildableId)) unsupported.push(`construction:${entry.buildableId}`);
    }
    return unsupported;
  }

  /** Grants one bundle inside the caller's transaction. Throws (rolling the caller back) when the roster/runes are full. */
  async grant(session: DbSession, userId: string, payload: ShopPackPayload, options: GrantOptions): Promise<ShopGrantsDto> {
    const currencies: CurrencyAmount[] = payload.currencies
      .map((entry) => ({ currencyId: entry.currencyId, amount: Number(entry.amount ?? 0) }))
      .filter((entry) => entry.amount > 0);
    for (const scroll of payload.scrolls) {
      const economy = resolveSummonEconomy(scroll.scrollId, this.deps.scrolls.get(scroll.scrollId), this.deps.currencies);
      currencies.push({ currencyId: economy.currencyId, amount: scroll.quantity });
    }

    const characters: ShopCharacterDto[] = [];
    for (const grant of payload.characters) {
      const isDuplicate = grant.duplicateGivesShards && !!grant.duplicateCompCurrencyId && grant.duplicateCompAmount > 0
        && (await this.deps.characters.ownsCharacterId(userId, grant.characterId, session));
      if (isDuplicate) {
        currencies.push({ currencyId: grant.duplicateCompCurrencyId!, amount: grant.duplicateCompAmount });
        continue;
      }

      const [record] = await this.deps.characterGrants.grant(session, userId, [{
        characterId: grant.characterId,
        stars: grant.star,
        level: grant.level,
        awakeningIndex: grant.awakeningIndex,
      }], "BAG", ErrorCode.ROSTER_FULL);
      characters.push({
        uid: record.uid,
        characterId: record.characterId,
        stars: record.stars,
        level: record.level,
        currentExp: record.currentExp,
        awakened: record.awakeningIndex > 0,
        skillLevels: record.skillLevels,
        awakeningIndex: record.awakeningIndex,
      });
    }

    const runeSpecs = payload.runes.flatMap((rune) => Array.from({ length: rune.quantity }, () => ({
      setId: rune.setId,
      slot: rune.slot,
      tier: rune.tier,
      quality: rune.quality,
      origin: options.runeOrigin,
    })));
    const runes = await this.deps.runes.grantRunes(session, userId, runeSpecs, { whenFull: "throw" });

    const constructions: ShopGrantsDto["constructions"] = [];
    if (options.constructions !== false) {
      for (const entry of payload.constructions) {
        let count = Math.floor(Number(entry.count));
        if (!(count > 0)) continue;
        if (!this.deps.constructions.exists(entry.buildableId)) {
          throw new AppError(ErrorCode.SHOP_REWARD_NOT_SUPPORTED, { extra: { rewards: [`construction:${entry.buildableId}`] } });
        }
        if (entry.forceUnique) {
          if ((await this.deps.constructions.ownedCount(userId, entry.buildableId, session)) > 0) continue;
          count = 1;
        }
        await this.deps.constructions.grant(userId, entry.buildableId, count, session);
        constructions.push({ buildableId: entry.buildableId, count });
      }
    }

    const merged = [...mergeAmounts(currencies)].map(([currencyId, amount]) => ({ currencyId, amount }));
    await this.deps.ledger.credit(session, userId, merged);
    return { currencies: merged, characters, runes, constructions };
  }
}
