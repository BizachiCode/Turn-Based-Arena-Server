import type { WalletItemDto } from "../economy/economy.dto.js";

/** Credentials returned after register/login/guest/refresh. */
export interface AuthResultDto {
  userId: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

/** Cleared stage entry (also returned by `map/progress`). */
export interface StageProgressDto {
  regionId: string;
  stageId: string;
  difficulty: string;
  clears: number;
  bestClearMs: number | null;
}

/** Account snapshot sent alongside every auth result. */
export interface AuthSnapshotDto {
  nickname: string;
  level: number;
  currentExp: number;
  wallet: WalletItemDto[];
  iconId: string | null;
  serverTimeUnix: number;
}

export type AuthOutcome = {
  result: AuthResultDto;
  account: AccountDto;
  snapshot: AuthSnapshotDto;
};

/** Account summary (`account` object of auth successes and of the `account` room). */
export interface AccountDto {
  userId: string;
  username: string;
  isGuest: boolean;
  /** null for guests. */
  email: string | null;
  createdAtUnix: number;
  /** Set while a deletion request is pending (hard delete date). */
  deletionScheduledAtUnix: number | null;
}
