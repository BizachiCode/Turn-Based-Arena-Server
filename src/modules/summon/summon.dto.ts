export type SummonTarget = "BAG" | "STORAGE";

/** Character created by a summon (`SummonGrantDTO` on the client). */
export type SummonGrantDto = {
  uid: string;
  characterId: string;
  stars: number;
  level: number;
  exp: number;
  currentExp: number;
  awakened: boolean;
  skillLevels: number[];
  awakeningIndex: number;
};

export type SummonResultDto = {
  ok: true;
  scrollId: string;
  currencyId: string;
  spent: number;
  walletAfter: Record<string, number>;
  wallet: Record<string, number>;
  grants: SummonGrantDto[];
  target: SummonTarget;
  /** Present (true) when this is the stored response of a repeated `requestId`. */
  replayed?: true;
};
