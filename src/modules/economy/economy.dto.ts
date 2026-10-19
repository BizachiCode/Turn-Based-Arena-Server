/** Wallet entry as sent to the client by `get_wallet` / the auth snapshot. */
export interface WalletItemDto {
  id: string;
  amount: number;
  lastTickUnix: number | null;
}

/** Wallet keyed by currency id (partial or full). */
export interface WalletSnapshotDto {
  [currencyId: string]: number;
}
