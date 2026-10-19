/** `{ currencyId, amount }` pair used by costs, rewards and grants. */
export type CurrencyAmount = {
  currencyId: string;
  amount: number;
};

/** Wallet snapshot keyed by currency id. */
export type WalletSnapshot = Record<string, number>;

/** Stage difficulty names as exported by Unity (ordered Easy..Hell). */
export type StageDifficulty = "Easy" | "Normal" | "Hard" | "Hell";

export const STAGE_DIFFICULTIES: readonly StageDifficulty[] = ["Easy", "Normal", "Hard", "Hell"];
