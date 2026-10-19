// Pure guild rules shared by the service (and mirrored by the Unity offline backend): name and text normalization,
// role permissions and the leader succession order.

import type { GuildConfig } from "../../config/GuildCatalog.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";

export const GUILD_ROLES = ["leader", "officer", "member"] as const;
export type GuildRole = (typeof GUILD_ROLES)[number];

export const GUILD_JOIN_TYPES = ["open", "approval"] as const;
export type GuildJoinType = (typeof GUILD_JOIN_TYPES)[number];

/** Guilds returned by `guild/list`. */
export const GUILD_LIST_SIZE = 30;

// Control characters (newlines included) are never allowed in names; texts keep single newlines.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
// "<" and ">" would let TextMeshPro rich-text tags into other players' screens.
const MARKUP_CHARS = /[<>]/;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export type NormalizedName = { name: string; key: string };

/** Uppercases the first character of every space-separated word (the rest is kept as typed). */
export function capitalizeWords(value: string): string {
  return value.split(" ").map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
}

/**
 * Validates a guild name: trimmed, inner whitespace collapsed, length within the config limits, at least one letter or
 * digit, no control/markup/forbidden characters; optionally capitalized. Returns the stored name and its lowercased
 * uniqueness key, or the error code `GUILD_NAME_INVALID`.
 */
export function normalizeGuildName(raw: string, cfg: GuildConfig): NormalizedName | { error: string } {
  let name = (raw ?? "").trim().replace(/\s+/g, " ");
  const length = [...name].length;
  if (length < cfg.minNameLength || length > cfg.maxNameLength) return { error: ErrorCode.GUILD_NAME_INVALID };
  if (CONTROL_CHARS.test(name) || MARKUP_CHARS.test(name) || !HAS_LETTER_OR_DIGIT.test(name)) return { error: ErrorCode.GUILD_NAME_INVALID };
  if (cfg.forbiddenCharacters.some((forbidden) => forbidden && name.includes(forbidden))) return { error: ErrorCode.GUILD_NAME_INVALID };
  if (cfg.autoCapitalizeName) name = capitalizeWords(name);
  return { name, key: name.toLowerCase() };
}

/**
 * Cleans a description/notice: trimmed, control characters removed (single newlines kept, at most two in a row),
 * markup characters removed unless rich text is allowed. Returns null when the result is longer than `max`.
 */
export function sanitizeGuildText(raw: string, max: number, allowRichText: boolean): string | null {
  let text = (raw ?? "").replace(/\r\n?/g, "\n").replace(CONTROL_CHARS_EXCEPT_NEWLINE, "");
  if (!allowRichText) text = text.replace(/[<>]/g, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return [...text].length > max ? null : text;
}

/** Leader and officers handle requests, kick members and edit the guild settings and notice. */
export function canManage(role: GuildRole): boolean {
  return role === "leader" || role === "officer";
}

/** The leader can kick any other member; officers kick plain members only. */
export function canKick(actor: GuildRole, target: GuildRole): boolean {
  if (target === "leader") return false;
  if (actor === "leader") return true;
  return actor === "officer" && target === "member";
}

/** Next leader when the current one leaves the game: the longest-serving officer, else the longest-serving member. */
export function pickSuccessor<T extends { role: GuildRole; joinedAt: Date; userId: string }>(members: readonly T[]): T | null {
  const candidates = members.filter((member) => member.role !== "leader");
  if (candidates.length === 0) return null;
  const rank = (role: GuildRole) => (role === "officer" ? 0 : 1);
  return [...candidates].sort((a, b) =>
    rank(a.role) - rank(b.role) || a.joinedAt.getTime() - b.joinedAt.getTime() || a.userId.localeCompare(b.userId))[0];
}

/** Escapes `%`, `_` and `\` for a LIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
