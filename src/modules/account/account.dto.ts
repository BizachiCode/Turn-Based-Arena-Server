export type { AccountDto } from "../auth/auth.dto.js";

export interface RevokedDevicesResultDto {
  /** Other devices whose refresh token and/or session were revoked. */
  revokedDevices: number;
}

export interface DeletionRequestResultDto {
  deletionScheduledAtUnix: number;
  graceDays: number;
}
