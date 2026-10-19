import { toWalletItems } from "../economy/economy.mapper.js";
import type { WalletRow } from "../economy/economy.ports.js";
import type { AccountDto, AuthSnapshotDto } from "./auth.dto.js";
import type { AccountRow } from "./auth.ports.js";

export function toSnapshotDto(data: {
  nickname: string;
  level: number;
  currentExp: number;
  wallet: WalletRow[];
  iconId: string | null;
  serverTimeUnix: number;
}): AuthSnapshotDto {
  return {
    nickname: data.nickname,
    level: data.level,
    currentExp: data.currentExp,
    wallet: toWalletItems(data.wallet),
    iconId: data.iconId,
    serverTimeUnix: data.serverTimeUnix,
  };
}

const toUnix = (date: Date): number => Math.floor(date.getTime() / 1000);

export function toAccountDto(row: AccountRow): AccountDto {
  return {
    userId: row.id,
    username: row.username,
    isGuest: row.isGuest,
    email: row.isGuest ? null : row.email,
    createdAtUnix: toUnix(row.createdAt),
    deletionScheduledAtUnix: row.deletionScheduledAt ? toUnix(row.deletionScheduledAt) : null,
  };
}
