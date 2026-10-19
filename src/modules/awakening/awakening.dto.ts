export type CurrencyCostDto = {
  currencyId: string;
  amount: number;
};

/** Character after awakening (`ServerCharDTO`). */
export type PlayerCharacterInstanceDto = {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  currentExp: number;
  awakened: boolean;
  awakeningIndex: number;
  skillLevels: number[];
};

export type AwakenPreviewNeedDto = {
  currencyId: string;
  need: number;
  have: number;
  missing: number;
};

export type AwakenSuccessDto = {
  ok: true;
  instance: PlayerCharacterInstanceDto;
  walletAfter: Record<string, number>;
  wallet: Record<string, number>;
  consumed: CurrencyCostDto[];
  /** Present (true) when this is the stored response of a repeated `requestId`. */
  replayed?: true;
};

/** Awakening error codes (sent verbatim to the client). */
export const AwakenError = {
  INVALID_REQUEST: "INVALID_REQUEST",
  CHAR_NOT_FOUND: "CHAR_NOT_FOUND",
  CATALOG_NOT_FOUND: "CATALOG_NOT_FOUND",
  NO_MORE_AWAKENINGS: "NO_MORE_AWAKENINGS",
  REQUIREMENT_LEVEL: "REQUIREMENT_LEVEL",
  REQUIREMENT_STARS: "REQUIREMENT_STARS",
  INSUFFICIENT_CURRENCY: "INSUFFICIENT_CURRENCY",
} as const;
