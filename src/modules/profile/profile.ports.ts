import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type ProfileRow = {
  name: string;
  iconId: string;
  level: number;
  currentExp: number;
};

/** Persistence port for `user_profile`. */
export interface ProfileRepository {
  findByUserId(userId: string, session?: DbSession): Promise<ProfileRow | null>;
  isNameTaken(name: string, exceptUserId?: string, session?: DbSession): Promise<boolean>;
  insertProfile(userId: string, profile: ProfileRow, session?: DbSession): Promise<void>;
  updateNickname(userId: string, nickname: string, session?: DbSession): Promise<void>;
  updateIcon(userId: string, iconId: string, session?: DbSession): Promise<void>;
}

/** Profile icon rules (`icons.json`). */
export interface IconRules {
  exists(iconId: string): boolean;
  defaultIconId(): string;
}

/** Nickname rules (`config.json > profile.nickname`). */
export type NicknameRules = {
  minLength: number;
  maxLength: number;
  canUseSpecialChar: boolean;
};
