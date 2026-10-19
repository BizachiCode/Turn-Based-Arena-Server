import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { RandomSource } from "../../shared/kernel/random.js";
import type { TextGuard } from "../../shared/kernel/text-guard.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { ChangeIconResultDto, ChangeNicknameResultDto } from "./profile.dto.js";
import type { IconRules, NicknameRules, ProfileRepository, ProfileRow } from "./profile.ports.js";

/** Nickname validation error codes (sent verbatim to the client). */
export const NicknameError = {
  EMPTY: "EMPTY",
  TOO_SHORT: "TOO_SHORT",
  TOO_LONG: "TOO_LONG",
  INVALID_CHARS: "INVALID_CHARS",
} as const;

/**
 * Never allowed, even with `canUseSpecialChar`: control and format characters (terminal escapes, zero-width and
 * direction marks), private-use and unassigned code points, line / paragraph separators. Names show up in other
 * players' chat, friends lists and the GM panel.
 */
const NICKNAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/u;

export function validateNickname(raw: string, rules: NicknameRules): string | null {
  const value = (raw ?? "").trim();
  if (!value) return NicknameError.EMPTY;
  if (value.length < rules.minLength) return NicknameError.TOO_SHORT;
  if (value.length > rules.maxLength) return NicknameError.TOO_LONG;
  if (NICKNAME_FORBIDDEN.test(value)) return NicknameError.INVALID_CHARS;
  if (!rules.canUseSpecialChar && !/^[A-Za-z0-9 _.\-]+$/.test(value)) return NicknameError.INVALID_CHARS;
  return null;
}

export class ProfileService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly icons: IconRules,
    private readonly nicknameRules: () => NicknameRules,
    private readonly random: RandomSource,
    /** Chat word filter (block mode): refuses nicknames that contain a banned word. */
    private readonly textGuard: TextGuard | null = null,
  ) {}

  async getProfile(userId: string, session?: DbSession): Promise<ProfileRow | null> {
    const profile = await this.profiles.findByUserId(userId, session);
    return profile ? { ...profile, iconId: profile.iconId || this.icons.defaultIconId() } : null;
  }

  /** Returns the profile, creating it with a unique display name when missing. */
  async ensureProfile(userId: string, fallbackName: string, session?: DbSession): Promise<ProfileRow> {
    const existing = await this.profiles.findByUserId(userId, session);
    if (existing) return { ...existing, iconId: existing.iconId || this.icons.defaultIconId() };

    let name = (fallbackName || "Player").trim() || "Player";
    if (await this.profiles.isNameTaken(name, undefined, session)) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `${name}#${this.random.int(10000).toString().padStart(4, "0")}`;
        if (!(await this.profiles.isNameTaken(candidate, undefined, session))) {
          name = candidate;
          break;
        }
      }
    }

    const profile: ProfileRow = { name, iconId: this.icons.defaultIconId(), level: 1, currentExp: 0 };
    await this.profiles.insertProfile(userId, profile, session);
    return profile;
  }

  /** `operator` (GM rename) skips the word filter; every other rule applies. */
  async changeNickname(userId: string, nickname: string, options: { operator?: boolean } = {}): Promise<ChangeNicknameResultDto> {
    const error = validateNickname(nickname, this.nicknameRules());
    if (error) throw new AppError(error);
    if (!options.operator && this.textGuard?.rejects(nickname)) throw new AppError(ErrorCode.TEXT_BLOCKED);

    const next = nickname.trim();
    if (await this.profiles.isNameTaken(next, userId)) throw new AppError(ErrorCode.PROFILE_NAME_TAKEN);

    // The check above and the write below are not atomic: a concurrent rename / registration to the same name is
    // stopped by the unique index and answered like the pre-check would have.
    try {
      await this.ensureProfile(userId, next);
      await this.profiles.updateNickname(userId, next);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError(ErrorCode.PROFILE_NAME_TAKEN);
      throw error;
    }
    return { nickname: next };
  }

  async changeIcon(userId: string, iconId: string): Promise<ChangeIconResultDto> {
    const next = (iconId ?? "").trim();
    if (!next || !this.icons.exists(next)) throw new AppError(ErrorCode.PROFILE_INVALID_ICON);

    await this.ensureProfile(userId, "Player");
    await this.profiles.updateIcon(userId, next);
    return { iconId: next };
  }
}
