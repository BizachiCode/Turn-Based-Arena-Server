import type { CurrencyAmount, WalletSnapshot } from "../../shared/kernel/types.js";
import type { RuneSyncDto } from "../rune/rune.dto.js";
import type { ShopCounter } from "./shop.ports.js";

/** `ServerCharDTO` on the client. */
export type ShopCharacterDto = {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  currentExp: number;
  awakened: boolean;
  skillLevels: number[];
  awakeningIndex: number;
};

export type ShopStateDto = {
  ok: true;
  serverTimeUnix: number;
  /** Purchase count of every limited item in its current window. */
  counters: ShopCounter[];
  /** Items bought at least once (first-purchase bonus already consumed). */
  firstPurchased: string[];
  /** Real-money items are granted without payment (demo builds, see `shop/iap_check`). */
  iapDemo: boolean;
};

/** `shop/iap_check`: the item can be bought now; the client opens the store payment (or sends a demo receipt). */
export type ShopIapCheckDto = {
  ok: true;
  itemId: string;
  /** Store product id to buy (the item's current price). */
  productId: string;
  /** Demo purchases are on: send a `Demo` receipt instead of opening the store. */
  demo: boolean;
  /** UUID bound to the purchase: Apple `appAccountToken`, Google `obfuscatedAccountId`. */
  accountToken: string;
};

/** Buildings added to the player's inventory. */
export type ShopConstructionGrantDto = { buildableId: string; count: number };

export type ShopGrantsDto = {
  currencies: CurrencyAmount[];
  characters: ShopCharacterDto[];
  runes: RuneSyncDto[];
  constructions: ShopConstructionGrantDto[];
};

export type ShopPurchaseDto = {
  ok: true;
  itemId: string;
  currencyId: string | null;
  priceSpent: number;
  wallet: WalletSnapshot;
  grants: ShopGrantsDto;
  counter: ShopCounter;
  firstPurchaseBonusGranted: boolean;
};
