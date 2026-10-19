// Runtime wrapper of the chat word filter: compiles the live config once per change, applies it to chat lines and
// counts what it masked / blocked per player (memory only, reset on restart; shown in the GM panel "Chat" view).

import type { Clock } from "../../shared/kernel/clock.js";
import type { TextGuard } from "../../shared/kernel/text-guard.js";
import {
  applyChatFilter,
  compileChatFilter,
  DEFAULT_CHAT_FILTER_CONFIG,
  type ChatFilterConfig,
  type CompiledChatFilter,
} from "./chat-filter.js";

/** Live `config.json > chat > filter` (must return the same object until the config reloads). */
export type ChatFilterSource = () => ChatFilterConfig;

/** Players tracked in the stats; the oldest entries go first. */
const STATS_CAP = 5000;

export type ChatFilterPlayerStats = { userId: string; masked: number; blocked: number; lastAtUnix: number };

export type ChatFilterOutcome = { ok: true; text: string; masked: boolean } | { ok: false };

export type ChatFilterPreview = {
  enabled: boolean;
  mode: "mask" | "block";
  matched: boolean;
  /** The chat would refuse the message (block mode with a match). */
  blocked: boolean;
  input: string;
  output: string;
};

export class ChatTextFilter implements TextGuard {
  private source: ChatFilterConfig | null = null;
  private compiled: CompiledChatFilter = compileChatFilter(DEFAULT_CHAT_FILTER_CONFIG);
  private readonly stats = new Map<string, ChatFilterPlayerStats>();
  private totals = { masked: 0, blocked: 0 };
  private readonly sinceUnix: number;

  constructor(
    private readonly configSource: ChatFilterSource,
    private readonly clock: Clock,
  ) {
    this.sinceUnix = clock.nowUnix();
  }

  /** The compiled filter of the live config (recompiled when the config object changed). */
  current(): CompiledChatFilter {
    const config = this.configSource();
    if (config !== this.source) {
      this.source = config;
      this.compiled = compileChatFilter(config);
    }
    return this.compiled;
  }

  /** Filters a chat line of `userId`: masked text, or `{ ok: false }` when the message must be refused. */
  filterMessage(userId: string, text: string): ChatFilterOutcome {
    const filter = this.current();
    if (!filter.enabled) return { ok: true, text, masked: false };
    const result = applyChatFilter(filter, text);
    if (!result.matched) return { ok: true, text, masked: false };

    if (filter.mode === "block") {
      this.count(userId, "blocked");
      return { ok: false };
    }
    this.count(userId, "masked");
    return { ok: true, text: result.text, masked: true };
  }

  /** True when masked lines may carry their unmasked text to clients (`allowPlayerOptOut`; never in block mode). */
  allowsOriginal(): boolean {
    const config = this.configSource();
    return config.mode === "mask" && config.allowPlayerOptOut !== false;
  }

  /** Block mode only: nicknames and guild texts are refused, never rewritten. */
  rejects(text: string): boolean {
    const filter = this.current();
    return filter.enabled && filter.mode === "block" && applyChatFilter(filter, String(text ?? "")).matched;
  }

  /** What the chat would do with `text` right now (GM "Test filter"); not counted in the stats. */
  preview(text: string): ChatFilterPreview {
    const filter = this.current();
    const result = applyChatFilter(filter, text);
    const blocked = result.matched && filter.mode === "block";
    return {
      enabled: filter.enabled,
      mode: filter.mode,
      matched: result.matched,
      blocked,
      input: text,
      output: blocked ? text : result.text,
    };
  }

  describe() {
    const filter = this.current();
    return {
      enabled: filter.enabled,
      mode: filter.mode,
      wholeWordOnly: filter.wholeWordOnly,
      allowPlayerOptOut: this.allowsOriginal(),
      maskChar: filter.maskChar,
      words: filter.wordCount,
      allowList: filter.allowCount,
    };
  }

  /** Counters since boot, busiest players first. */
  snapshot(limit = 25): { sinceUnix: number; masked: number; blocked: number; players: ChatFilterPlayerStats[] } {
    const players = [...this.stats.values()]
      .sort((a, b) => b.masked + b.blocked - (a.masked + a.blocked) || b.lastAtUnix - a.lastAtUnix)
      .slice(0, Math.max(1, limit));
    return { sinceUnix: this.sinceUnix, masked: this.totals.masked, blocked: this.totals.blocked, players };
  }

  private count(userId: string, kind: "masked" | "blocked"): void {
    this.totals[kind] += 1;
    const entry = this.stats.get(userId) ?? { userId, masked: 0, blocked: 0, lastAtUnix: 0 };
    entry[kind] += 1;
    entry.lastAtUnix = this.clock.nowUnix();
    // Re-insert so the least recently active players are the ones evicted at the cap.
    this.stats.delete(userId);
    this.stats.set(userId, entry);
    if (this.stats.size > STATS_CAP) {
      const oldest = this.stats.keys().next().value;
      if (oldest !== undefined) this.stats.delete(oldest);
    }
  }
}
