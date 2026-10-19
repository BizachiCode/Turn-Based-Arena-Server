// Player reports: vocabulary and live tuning (`config.json > reports`, with defaults).

export const REPORT_CATEGORIES = ["spam", "offensive", "cheating", "name", "other"] as const;
export type ReportCategory = typeof REPORT_CATEGORIES[number];

/** Where the reporter saw the player. `global_chat` / `guild_chat` / `private_chat` may carry a `messageId`. */
export const REPORT_SOURCES = ["global_chat", "guild_chat", "private_chat", "profile", "arena", "friends", "other"] as const;
export type ReportSource = typeof REPORT_SOURCES[number];

export type ReportStatus = "open" | "resolved" | "dismissed";
export type ReportAction = "none" | "warn" | "mute" | "kick" | "ban";

export const REPORT_COMMENT_MAX = 300;

/**
 * Text copied into a report as evidence for a stored chat line: what the sender really wrote. The chat word filter
 * stores the unmasked text next to the masked one (`original_message`), so GMs never review asterisks.
 */
export function reportEvidenceText(row: { message: string; originalMessage: string | null }): string {
  return row.originalMessage || row.message;
}

export type ReportRules = {
  enabled: boolean;
  /** Reports one player may file per rolling 24 hours. */
  dailyLimit: number;
  /** Minimum seconds between two reports of the same player. */
  cooldownSeconds: number;
  /** Categories the client may use (subset of {@link REPORT_CATEGORIES}). */
  categories: ReportCategory[];
  /** Lines of the target's stored chat history copied into the report (0 = none). */
  historyLines: number;
  /** Mail the reporter when a GM resolves the report with an action. */
  notifyReporter: boolean;
};

export const DEFAULT_REPORT_RULES: Readonly<ReportRules> = Object.freeze({
  enabled: true,
  dailyLimit: 10,
  cooldownSeconds: 30,
  categories: [...REPORT_CATEGORIES],
  historyLines: 5,
  notifyReporter: true,
});

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Validates a raw `config.json > reports` object (unknown keys ignored, missing keys take the defaults). */
export function normalizeReportRules(raw: unknown): ReportRules {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const categories = Array.isArray(source.categories)
    ? REPORT_CATEGORIES.filter((category) => (source.categories as unknown[]).includes(category))
    : [...DEFAULT_REPORT_RULES.categories];
  return {
    enabled: source.enabled === undefined ? DEFAULT_REPORT_RULES.enabled : source.enabled === true,
    dailyLimit: boundedInt(source.dailyLimit, DEFAULT_REPORT_RULES.dailyLimit, 1, 1000),
    cooldownSeconds: boundedInt(source.cooldownSeconds, DEFAULT_REPORT_RULES.cooldownSeconds, 0, 86_400),
    categories: categories.length > 0 ? categories : [...DEFAULT_REPORT_RULES.categories],
    historyLines: boundedInt(source.historyLines, DEFAULT_REPORT_RULES.historyLines, 0, 20),
    notifyReporter: source.notifyReporter === undefined ? DEFAULT_REPORT_RULES.notifyReporter : source.notifyReporter === true,
  };
}
