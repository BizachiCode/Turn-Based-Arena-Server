import type { WalletRow } from "./economy.ports.js";
import type { WalletItemDto, WalletSnapshotDto } from "./economy.dto.js";

export function toWalletItems(rows: WalletRow[]): WalletItemDto[] {
  return rows.map((row) => ({
    id: row.currencyId,
    amount: Number(row.amount),
    lastTickUnix: row.lastTickAt ? Math.floor(row.lastTickAt.getTime() / 1000) : null,
  }));
}

export function toWalletSnapshot(rows: WalletRow[]): WalletSnapshotDto {
  const snapshot: WalletSnapshotDto = {};
  for (const row of rows) snapshot[row.currencyId] = Number(row.amount);
  return snapshot;
}
