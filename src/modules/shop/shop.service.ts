// Shop use cases: purchase counters/state and the atomic purchase (validate → pay → grant → count).

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { ShopItem } from "../../config/ShopCatalog.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { MapProgressRepository } from "../map/map.ports.js";
import type { CharacterGrantService } from "../roster/character-grant.service.js";
import type { RosterCache } from "../roster/roster.cache.js";
import type { CharacterRepository } from "../roster/roster.ports.js";
import type { RuneCache } from "../rune/rune.cache.js";
import type { RuneService } from "../rune/rune.service.js";
import type { SummonCurrencyLookup, SummonRules } from "../summon/summon.ports.js";
import { mergeGrants, RewardGranter } from "../rewards/reward-granter.js";
import { createLogger } from "../../shared/logger.js";
import { hasLimit, isAvailable, LIFETIME_WINDOW, planConstructions, priceFor, windowKeyFor, type ConstructionPlan } from "./shop.domain.js";
import type { ShopIapCheckDto, ShopPurchaseDto, ShopStateDto } from "./shop.dto.js";
import type { ConstructionInventory, ShopCatalogSource, ShopRepository } from "./shop.ports.js";
import { iapAccountToken, iapPurchaseId } from "./iap/iap.domain.js";
import type { IapReceipt, IapReceiptValidator, IapTransactionRepository, VerifiedIapPurchase } from "./iap/iap.ports.js";

const logger = createLogger("ShopService");

export type PurchaseRequest = {
  itemId: string;
  /** Idempotency key: a retry with the same id returns the first response without buying again. */
  purchaseId?: string | null;
  expectedPrice?: { currencyId: string | null; amount: number } | null;
  /** Store receipt of a RealMoneyIAP item (verified by `ShopServiceDeps.iap`). */
  receipt?: IapReceipt | null;
};

export type ShopServiceDeps = {
  shop: ShopRepository;
  catalog: ShopCatalogSource;
  ledger: WalletLedger;
  characters: CharacterRepository;
  characterGrants: CharacterGrantService;
  runes: RuneService;
  /** Building inventory for `constructions` rewards. */
  constructions: ConstructionInventory;
  progress: MapProgressRepository;
  scrolls: SummonRules;
  currencies: SummonCurrencyLookup;
  accountLevel: (userId: string, session?: DbSession) => Promise<number>;
  /** Receipt validation of real-money items (null = RealMoneyIAP items answer IAP_NOT_SUPPORTED). */
  iap: IapReceiptValidator | null;
  /** Delivered store transactions (one delivery per receipt, across accounts). */
  iapTransactions: IapTransactionRepository;
  rosterCache: RosterCache;
  runeCache: RuneCache;
  audit: AuditLog;
  uow: UnitOfWork;
  clock: Clock;
};

const SHOP_GRANT = { runeOrigin: "shop", constructions: false } as const;

export class ShopService {
  private readonly rewards: RewardGranter;

  constructor(private readonly deps: ShopServiceDeps) {
    this.rewards = new RewardGranter(deps);
  }

  async getState(userId: string): Promise<ShopStateDto> {
    const now = this.deps.clock.now();
    const counters = await this.deps.shop.listCounters(userId);
    const byKey = new Map(counters.map((counter) => [`${counter.itemId}|${counter.windowKey}`, counter.count]));

    const catalog = this.deps.catalog.catalog();
    const items = catalog.items;
    return {
      ok: true,
      serverTimeUnix: this.deps.clock.nowUnix(),
      counters: items.filter(hasLimit).map((item) => {
        const windowKey = windowKeyFor(item, now);
        return { itemId: item.itemId, windowKey, count: byKey.get(`${item.itemId}|${windowKey}`) ?? 0 };
      }),
      firstPurchased: items
        .filter((item) => (byKey.get(`${item.itemId}|${LIFETIME_WINDOW}`) ?? 0) > 0)
        .map((item) => item.itemId),
      iapDemo: this.deps.iap?.demoEnabled(catalog.iap) ?? false,
    };
  }

  /**
   * Asked before a real-money purchase opens the store payment sheet: runs every check of `purchase` (availability,
   * eligibility, limits, unique buildings) without charging, so the player is not asked to pay for an item the server
   * would refuse. Answers the store product id, whether demo purchases are on and the account token to bind the
   * purchase to this account (Apple `appAccountToken`, Google `obfuscatedAccountId`).
   */
  async iapCheck(userId: string, itemId: string): Promise<ShopIapCheckDto> {
    const item = this.deps.catalog.get(itemId);
    if (!item) throw new AppError(ErrorCode.SHOP_ITEM_NOT_FOUND);
    const now = this.deps.clock.now();
    await this.checkPurchasable(userId, item, now);

    const windowKey = windowKeyFor(item, now);
    const productId = await this.deps.uow.transaction(async (session) => {
      const counts = await this.deps.shop.lockCounters(userId, item.itemId, [windowKey, LIFETIME_WINDOW], session);
      const inWindow = counts.get(windowKey) ?? 0;
      await this.checkLimits(userId, item, inWindow, counts.get(LIFETIME_WINDOW) ?? 0, session);
      const price = priceFor(item, inWindow, now);
      if (price.kind !== "RealMoneyIAP" || !price.iapProductId) throw new AppError(ErrorCode.IAP_NOT_SUPPORTED, { extra: { detail: "NOT_REAL_MONEY" } });
      return price.iapProductId;
    });

    return {
      ok: true,
      itemId: item.itemId,
      productId,
      demo: this.deps.iap?.demoEnabled(this.deps.catalog.catalog().iap) ?? false,
      accountToken: iapAccountToken(userId),
    };
  }

  async purchase(userId: string, request: PurchaseRequest): Promise<ShopPurchaseDto> {
    const item = this.deps.catalog.get(request.itemId);
    if (!item) throw new AppError(ErrorCode.SHOP_ITEM_NOT_FOUND);

    // Real money: the store is asked BEFORE the transaction (no row lock is held during the network call). A receipt
    // delivered already answers its first response, even when the item is sold out by now (the client must still
    // finish the store transaction).
    let verified: VerifiedIapPurchase | null = null;
    if (request.receipt) {
      const delivery = await this.verifyReceipt(userId, request.receipt);
      if ("replay" in delivery) return delivery.replay;
      verified = delivery.verified;
    }

    const now = this.deps.clock.now();
    // A verified payment is delivered even if its offer window closed meanwhile (the player paid while it was shown).
    await this.checkPurchasable(userId, item, now, { skipAvailability: verified !== null });

    const windowKey = windowKeyFor(item, now);
    const purchaseId = verified ? iapPurchaseId(verified.transactionKey) : request.purchaseId ?? null;
    const result = await this.deps.uow.transaction(async (session) => {
      if (purchaseId) {
        const previous = await this.deps.shop.findPurchaseResponse(userId, purchaseId, session);
        if (previous) return { replayed: true as const, response: previous as ShopPurchaseDto };
      }

      const counts = await this.deps.shop.lockCounters(userId, item.itemId, [windowKey, LIFETIME_WINDOW], session);
      const inWindow = counts.get(windowKey) ?? 0;
      const lifetime = counts.get(LIFETIME_WINDOW) ?? 0;
      const { firstPurchaseBonus, constructions } = await this.checkLimits(userId, item, inWindow, lifetime, session);

      const price = priceFor(item, inWindow, now);
      const currencyId = price.kind === "RealMoneyIAP" ? null : price.currencyId ?? null;
      if (request.expectedPrice && (request.expectedPrice.amount !== price.amount || (request.expectedPrice.currencyId ?? null) !== currencyId)) {
        throw new AppError(ErrorCode.PRICE_CHANGED, { fields: { price: { currencyId, amount: price.amount } } });
      }

      if (price.kind === "RealMoneyIAP") {
        if (!verified) throw new AppError(ErrorCode.IAP_NOT_SUPPORTED, { extra: { detail: "RECEIPT_REQUIRED" } });
        if (verified.productId !== price.iapProductId) {
          throw new AppError(ErrorCode.IAP_PRODUCT_MISMATCH, { extra: { productId: price.iapProductId } });
        }
        const recorded = await this.deps.iapTransactions.insert({
          transactionKey: verified.transactionKey,
          store: verified.store,
          userId,
          itemId: item.itemId,
          productId: verified.productId,
          purchaseId: purchaseId!,
          orderId: verified.orderId,
          environment: verified.environment,
        }, session);
        // Another delivery of the same receipt committed first (two devices, or another account).
        if (!recorded) throw new AppError(ErrorCode.IAP_RECEIPT_USED);
      } else if (verified) {
        throw new AppError(ErrorCode.IAP_PRODUCT_MISMATCH, { extra: { detail: "NOT_REAL_MONEY" } });
      } else if (price.amount > 0) {
        if (!currencyId) throw new AppError(ErrorCode.SHOP_ITEM_NOT_FOUND, { extra: { detail: "PRICE_WITHOUT_CURRENCY" } });
        await this.deps.ledger.debit(session, userId, [{ currencyId, amount: price.amount }]);
      }

      // Buildings are planned above (forceUnique checks before charging), so the granter skips them here.
      const grants = await this.rewards.grant(session, userId, item.rewards, SHOP_GRANT);
      if (firstPurchaseBonus) mergeGrants(grants, await this.rewards.grant(session, userId, item.firstPurchaseBonus, SHOP_GRANT));
      for (const line of constructions) {
        await this.deps.constructions.grant(userId, line.buildableId, line.count, session);
        grants.constructions.push({ buildableId: line.buildableId, count: line.count });
      }

      if (windowKey !== LIFETIME_WINDOW) await this.deps.shop.incrementCounter(userId, item.itemId, windowKey, session);
      await this.deps.shop.incrementCounter(userId, item.itemId, LIFETIME_WINDOW, session);
      const priceSpent = price.kind === "RealMoneyIAP" ? 0 : price.amount;
      const response: ShopPurchaseDto = {
        ok: true,
        itemId: item.itemId,
        currencyId,
        priceSpent,
        wallet: await this.deps.ledger.snapshot(userId, session),
        grants,
        counter: { itemId: item.itemId, windowKey, count: (windowKey === LIFETIME_WINDOW ? lifetime : inWindow) + 1 },
        firstPurchaseBonusGranted: firstPurchaseBonus,
      };

      await this.deps.shop.logPurchase({
        userId,
        itemId: item.itemId,
        windowKey,
        currencyId,
        price: priceSpent,
        firstPurchase: lifetime === 0,
        grants,
        purchaseId,
        response,
      }, session);
      const iapMeta = verified ? { store: verified.store, orderId: verified.orderId, environment: verified.environment } : {};
      await this.deps.audit.record({ userId, kind: "SHOP_PURCHASE", meta: { itemId: item.itemId, currencyId, price: priceSpent, purchaseId, ...iapMeta } }, session);

      return { replayed: false as const, response };
    });

    if (!result.replayed) {
      if (result.response.grants.characters.length > 0) await this.deps.rosterCache.invalidate(userId);
      if (result.response.grants.runes.length > 0) await this.deps.runeCache.invalidate(userId);
      if (verified?.afterGrant) {
        verified.afterGrant().catch((error) => logger.warn(`after-grant step of ${verified!.store} failed:`, (error as Error).message));
      }
    }
    return result.response;
  }

  /** Availability (unless skipped), eligibility and unknown buildings: everything checked outside the transaction. */
  private async checkPurchasable(userId: string, item: ShopItem, now: Date, options: { skipAvailability?: boolean } = {}): Promise<void> {
    if (!options.skipAvailability && !isAvailable(item, now, this.deps.catalog.catalog().activeRotationTags)) {
      throw new AppError(ErrorCode.SHOP_NOT_AVAILABLE);
    }
    await this.checkEligibility(userId, item);

    const bonusPayloads = item.limit.giveFirstPurchaseBonus ? [item.firstPurchaseBonus] : [];
    const unknownBuildings = planConstructions([item.rewards, ...bonusPayloads])
      .filter((line) => !this.deps.constructions.exists(line.buildableId))
      .map((line) => `construction:${line.buildableId}`);
    if (unknownBuildings.length > 0) throw new AppError(ErrorCode.SHOP_REWARD_NOT_SUPPORTED, { extra: { rewards: unknownBuildings } });
  }

  /** Purchase limits and `forceUnique` buildings, under the counters lock; returns what the purchase grants. */
  private async checkLimits(userId: string, item: ShopItem, inWindow: number, lifetime: number, session: DbSession)
    : Promise<{ firstPurchaseBonus: boolean; constructions: ConstructionPlan[] }> {
    if (item.limit.uniquePerAccount && lifetime >= 1) throw new AppError(ErrorCode.SHOP_LIMIT_REACHED);
    if (item.limit.scope !== "None" && inWindow >= item.limit.maxPurchases) throw new AppError(ErrorCode.SHOP_LIMIT_REACHED);

    // `forceUnique` buildings the player already owns reject the whole purchase BEFORE anything is charged or
    // delivered (a skipped grant would still take the price, or a real-money receipt, for nothing).
    const firstPurchaseBonus = item.limit.giveFirstPurchaseBonus && lifetime === 0;
    const constructions = planConstructions(firstPurchaseBonus ? [item.rewards, item.firstPurchaseBonus] : [item.rewards]);
    for (const line of constructions.filter((entry) => entry.unique)) {
      if ((await this.deps.constructions.ownedCount(userId, line.buildableId, session)) > 0) {
        throw new AppError(ErrorCode.SHOP_ALREADY_OWNED, { extra: { buildableId: line.buildableId } });
      }
    }
    return { firstPurchaseBonus, constructions };
  }

  private async checkEligibility(userId: string, item: ShopItem): Promise<void> {
    if (item.minAccountLevel > 0 && (await this.deps.accountLevel(userId)) < item.minAccountLevel) {
      throw new AppError(ErrorCode.SHOP_NOT_ELIGIBLE, { extra: { requirement: "minAccountLevel", value: item.minAccountLevel } });
    }

    if (item.requiredProgressId) {
      // `stageId`, `regionId:stageId` or `regionId:stageId:Difficulty`, compared ignoring case (same as the Offline backend).
      const [first, second, third] = item.requiredProgressId.trim().split(":").map((part) => part.trim().toLowerCase());
      const regionId = second !== undefined ? first : null;
      const stageId = second !== undefined ? second : first;
      const difficulty = third ?? null;
      const cleared = (await this.deps.progress.listProgress(userId)).some((row) =>
        row.stageId.toLowerCase() === stageId
        && (!regionId || row.regionId.toLowerCase() === regionId)
        && (!difficulty || row.difficulty.toLowerCase() === difficulty));
      if (!cleared) throw new AppError(ErrorCode.SHOP_NOT_ELIGIBLE, { extra: { requirement: "requiredProgressId", value: item.requiredProgressId } });
    }
  }

  /**
   * Verifies a store receipt, or answers the first response when this account already received it (the client retries
   * until it can finish the store transaction). A receipt delivered to another account answers IAP_RECEIPT_USED.
   */
  private async verifyReceipt(userId: string, receipt: IapReceipt): Promise<{ replay: ShopPurchaseDto } | { verified: VerifiedIapPurchase }> {
    const validator = this.deps.iap;
    if (!validator) throw new AppError(ErrorCode.IAP_NOT_SUPPORTED, { extra: { detail: "NO_VALIDATOR" } });
    const input = { userId, receipt, settings: this.deps.catalog.catalog().iap };

    const claimed = validator.claimedKey(input);
    if (claimed) {
      const replay = await this.replayDelivery(userId, claimed);
      if (replay) return { replay };
    }
    const verified = await validator.verify(input);
    if (verified.transactionKey !== claimed) {
      const replay = await this.replayDelivery(userId, verified.transactionKey);
      if (replay) return { replay };
    }
    return { verified };
  }

  private async replayDelivery(userId: string, transactionKey: string): Promise<ShopPurchaseDto | null> {
    const owner = await this.deps.iapTransactions.findOwner(transactionKey);
    if (!owner) return null;
    if (owner.userId !== userId) throw new AppError(ErrorCode.IAP_RECEIPT_USED);
    const response = await this.deps.uow.transaction((session) => this.deps.shop.findPurchaseResponse(userId, owner.purchaseId, session));
    if (!response) throw new AppError(ErrorCode.IAP_RECEIPT_USED);
    return response as ShopPurchaseDto;
  }
}
