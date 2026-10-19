// Chat word filter (server only: the Unity offline backend does not filter chat): pure, deterministic and
// table-driven (test cases: test/fixtures/chat-filter-cases.json). No I/O, no clock, no randomness, no regular expressions on
// the hot path (a trie over letter runs), so the cost per message does not depend on the size of the word list.
//
// Algorithm
//  1. Fold every code point of the text: NFD, drop combining marks, lower case, then the leet table (LEET_FOLD).
//     The word list goes through the same fold, so both sides are compared as "skeletons".
//  2. Classify each folded char: letter-like (\p{L} / \p{N}), soft separator (SOFT_SEPARATORS), whitespace or hard
//     boundary (any other punctuation: ", ! ? ( ) ..."). Combining marks stay attached to their base char.
//  3. Build the candidate tokens (each remembers where its chars sit in the original text):
//       V1  maximal runs of letter-like chars ("you  shit" -> "you", "shit")
//       V2  runs where soft separators are skipped ("f.u.c.k", "fu-ck" -> "fuck")
//       V3  windows of 2+ consecutive single-letter V1 tokens split by spaces/soft separators ("f u c k" -> "fuck")
//  4. A token is reduced to letter runs ("fuuuck" -> f u(3) c k). A word matches when its letters equal the token's
//     run letters and every run is at least as long as in the word: "fuck" = f+u+c+k+, "ass" = a+s{2,} (so "as"
//     never matches). wholeWordOnly: the match must cover the whole token; otherwise any run window of the token.
//     Words written in a script without word boundaries (Han, Hiragana, Katakana, Hangul: CJK_SCRIPT) match any
//     window even with wholeWordOnly, since a whole CJK sentence is a single token.
//  5. The allow list wins: a banned match lying inside a match of an allow-list word is dropped
//     ("scunthorpe", "class" while "cunt"/"ass" are banned).
//  6. mask mode replaces every char of the original text from the first to the last matched char (separators and
//     spaces inside included) with maskChar; block mode only reports `matched`.
//
// Known limits (by design, keep it simple): entries are single words (spaces are ignored), "*" is a separator
// and not a wildcard ("f*ck" is not caught), no homoglyph table beyond NFD + LEET_FOLD.

export type ChatFilterMode = "mask" | "block";

export type ChatFilterConfig = {
  enabled: boolean;
  mode: ChatFilterMode;
  /** First code point is used; "*" when empty. */
  maskChar: string;
  words: string[];
  allowList: string[];
  wholeWordOnly: boolean;
  /** Mask mode: lines carry the unmasked text as `original` so players can opt out of the filter on their client. */
  allowPlayerOptOut: boolean;
};

export const DEFAULT_CHAT_FILTER_CONFIG: Readonly<ChatFilterConfig> = Object.freeze({
  enabled: false,
  mode: "mask" as ChatFilterMode,
  maskChar: "*",
  words: [] as string[],
  allowList: [] as string[],
  wholeWordOnly: true,
  allowPlayerOptOut: true,
});

/** Folded confusables, applied to the text and to the word lists. "l" folds into "i" so 1 / l / i match each other. */
export const LEET_FOLD: Readonly<Record<string, string>> = Object.freeze({
  "0": "o",
  "1": "i",
  l: "i",
  "3": "e",
  "4": "a",
  "@": "a",
  "5": "s",
  $: "s",
  "7": "t",
});

/** Separators that may sit inside a word ("f.u.c.k", "f-u-c-k", "f_u_c_k"). */
const SOFT_SEPARATORS = ".-_*|~^";

const MAX_WORDS = 5000;
const MAX_WORD_LENGTH = 64;
const MIN_SKELETON_LENGTH = 2;
/** Longest word recognised when its letters are spaced out ("f u c k"). */
const MAX_SPACED_WORD = 16;

export type ChatFilterResult = {
  matched: boolean;
  /** The text with the matches masked (equal to the input when nothing matched). */
  text: string;
  /** Number of distinct masked spans. */
  spans: number;
};

/** Trie over the letter runs of the word list; `ends` holds the minimum run lengths of the words ending here. */
type TrieNode = { children: Map<string, TrieNode>; ends: TrieEnd[] };
/** `anywhere`: the word has CJK letters, so it matches inside a token even with wholeWordOnly. */
type TrieEnd = { minRuns: number[]; anywhere: boolean };

/** Scripts written without spaces between words. */
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export type CompiledChatFilter = {
  enabled: boolean;
  mode: ChatFilterMode;
  maskChar: string;
  wholeWordOnly: boolean;
  wordCount: number;
  allowCount: number;
  banned: TrieNode | null;
  allow: TrieNode | null;
  /** Some word of either list matches anywhere (CJK), so tokens are walked from every start even with wholeWordOnly. */
  hasAnywhere: boolean;
};

type Kind = "L" | "S" | "W" | "H";
/** One folded code point and the (inclusive) code point range of the original text it came from. */
type Unit = { ch: string; kind: Kind; start: number; end: number };
type Run = { letter: string; length: number; first: number; last: number };

/** Validates a raw `config.json > chat > filter` object into a full config (safe defaults for anything missing). */
export function normalizeChatFilterConfig(raw: unknown): ChatFilterConfig {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= MAX_WORD_LENGTH).slice(0, MAX_WORDS)
      : [];
  const maskChar = typeof source.maskChar === "string" ? Array.from(source.maskChar.trim())[0] : undefined;
  return {
    enabled: source.enabled === true,
    mode: source.mode === "block" ? "block" : "mask",
    maskChar: maskChar || DEFAULT_CHAT_FILTER_CONFIG.maskChar,
    words: list(source.words),
    allowList: list(source.allowList),
    wholeWordOnly: source.wholeWordOnly === undefined ? DEFAULT_CHAT_FILTER_CONFIG.wholeWordOnly : source.wholeWordOnly === true,
    allowPlayerOptOut: source.allowPlayerOptOut === undefined ? DEFAULT_CHAT_FILTER_CONFIG.allowPlayerOptOut : source.allowPlayerOptOut === true,
  };
}

/** Folds one code point: the letter-like chars it stands for (empty for a combining mark). */
function foldCodePoint(codePoint: string): string[] {
  const base = codePoint.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return Array.from(base).map((ch) => LEET_FOLD[ch] ?? ch);
}

function classify(ch: string): Kind {
  if (/[\p{L}\p{N}]/u.test(ch)) return "L";
  if (SOFT_SEPARATORS.includes(ch)) return "S";
  if (/\s/u.test(ch)) return "W";
  return "H";
}

/** Letters of a word-list entry after the same fold (anything that is not letter-like is dropped). */
function skeletonOf(word: string): string[] {
  const letters: string[] = [];
  for (const codePoint of Array.from(word)) {
    for (const ch of foldCodePoint(codePoint)) if (classify(ch) === "L") letters.push(ch);
  }
  return letters;
}

/** Builds the trie of a word list; returns it with the number of distinct entries. */
function buildTrie(entries: string[]): { root: TrieNode; count: number; hasAnywhere: boolean } | null {
  const root: TrieNode = { children: new Map(), ends: [] };
  const seen = new Set<string>();
  let hasAnywhere = false;
  for (const entry of entries) {
    const letters = skeletonOf(entry);
    if (letters.length < MIN_SKELETON_LENGTH) continue;
    const key = letters.join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);

    // "ass" -> runs [a:1, s:2]
    let node = root;
    const minRuns: number[] = [];
    for (let i = 0; i < letters.length; ) {
      let length = 1;
      while (i + length < letters.length && letters[i + length] === letters[i]) length++;
      let next = node.children.get(letters[i]);
      if (!next) {
        next = { children: new Map(), ends: [] };
        node.children.set(letters[i], next);
      }
      node = next;
      minRuns.push(length);
      i += length;
    }
    const anywhere = letters.some((ch) => CJK_SCRIPT.test(ch));
    hasAnywhere ||= anywhere;
    node.ends.push({ minRuns, anywhere });
  }
  return seen.size > 0 ? { root, count: seen.size, hasAnywhere } : null;
}

/** Compiles a config once; reuse the result until the config changes. */
export function compileChatFilter(config: Partial<ChatFilterConfig> | null | undefined): CompiledChatFilter {
  const full = normalizeChatFilterConfig(config);
  const banned = buildTrie(full.words);
  const allow = buildTrie(full.allowList);
  return {
    enabled: full.enabled && banned !== null,
    mode: full.mode,
    maskChar: full.maskChar,
    wholeWordOnly: full.wholeWordOnly,
    wordCount: banned?.count ?? 0,
    allowCount: allow?.count ?? 0,
    banned: banned?.root ?? null,
    allow: allow?.root ?? null,
    hasAnywhere: (banned?.hasAnywhere ?? false) || (allow?.hasAnywhere ?? false),
  };
}

function toUnits(codePoints: string[]): Unit[] {
  const units: Unit[] = [];
  codePoints.forEach((codePoint, index) => {
    const folded = foldCodePoint(codePoint);
    if (folded.length === 0) {
      // Pure combining mark: belongs to the previous char (masked together with it).
      const previous = units[units.length - 1];
      if (previous) previous.end = index;
      return;
    }
    for (const ch of folded) units.push({ ch, kind: classify(ch), start: index, end: index });
  });
  return units;
}

/** V1 (letter runs), V2 (letter runs with soft separators skipped) and V3 (spaced single letters), see the header. */
function buildTokens(units: Unit[]): Unit[][] {
  const tokens: Unit[][] = [];

  // V1: maximal runs of letters; remember where each run sits so V3 can inspect the gaps.
  const letterRuns: Array<{ units: Unit[]; first: number; last: number }> = [];
  for (let i = 0; i < units.length; i++) {
    if (units[i].kind !== "L") continue;
    const first = i;
    while (i + 1 < units.length && units[i + 1].kind === "L") i++;
    letterRuns.push({ units: units.slice(first, i + 1), first, last: i });
  }
  letterRuns.forEach((run) => tokens.push(run.units));

  // V2: letter runs joined across soft separators. Only runs that swallowed a separator add something over V1.
  let current: Unit[] = [];
  let swallowed = false;
  const closeV2 = () => {
    if (swallowed && current.length > 0) tokens.push(current);
    current = [];
    swallowed = false;
  };
  for (const unit of units) {
    if (unit.kind === "L") current.push(unit);
    else if (unit.kind === "S" && current.length > 0) swallowed = true;
    else closeV2();
  }
  closeV2();

  // V3: consecutive single-letter runs whose gaps hold only whitespace / soft separators ("f u c k").
  // Every window of 2..MAX_SPACED_WORD letters is a candidate, so "u r a b i t c h" still exposes "b i t c h".
  let group: Unit[] = [];
  const closeV3 = () => {
    for (let from = 0; from + 1 < group.length; from++) {
      for (let length = 2; length <= MAX_SPACED_WORD && from + length <= group.length; length++) {
        tokens.push(group.slice(from, from + length));
      }
    }
    group = [];
  };
  letterRuns.forEach((run, index) => {
    const previous = letterRuns[index - 1];
    const gapIsClean = !previous || units.slice(previous.last + 1, run.first).every((unit) => unit.kind !== "H");
    if (run.units.length !== 1 || !gapIsClean) closeV3();
    if (run.units.length === 1) group.push(run.units[0]);
  });
  closeV3();

  return tokens;
}

/** Letter runs of a token ("fuuck" -> f, u x2, c, k). */
function runsOf(token: Unit[]): Run[] {
  const runs: Run[] = [];
  token.forEach((unit, index) => {
    const last = runs[runs.length - 1];
    if (last && last.letter === unit.ch) {
      last.length++;
      last.last = index;
    } else {
      runs.push({ letter: unit.ch, length: 1, first: index, last: index });
    }
  });
  return runs;
}

/** Calls `found(fromRun, toRun)` (toRun exclusive) for every word of the trie matching a window of `runs`. */
function walk(root: TrieNode, runs: Run[], startsAtZeroOnly: boolean, found: (from: number, to: number, anywhere: boolean) => void): void {
  const lastStart = startsAtZeroOnly ? 0 : runs.length - 1;
  for (let from = 0; from <= lastStart; from++) {
    let node: TrieNode | undefined = root;
    for (let to = from; to < runs.length; to++) {
      node = node.children.get(runs[to].letter);
      if (!node) break;
      for (const end of node.ends) {
        let ok = true;
        for (let t = 0; t < end.minRuns.length && ok; t++) ok = runs[from + t].length >= end.minRuns[t];
        if (ok) found(from, to + 1, end.anywhere);
      }
    }
  }
}

/** Match spans (inclusive code point indices of the original text) of the banned words found in one token. */
function matchToken(filter: CompiledChatFilter, token: Unit[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!filter.banned) return spans;
  const runs = runsOf(token);
  const whole = filter.wholeWordOnly;
  const fromZeroOnly = whole && !filter.hasAnywhere;

  const allowed: Array<[number, number]> = [];
  if (filter.allow) walk(filter.allow, runs, fromZeroOnly, (from, to) => allowed.push([from, to]));

  walk(filter.banned, runs, fromZeroOnly, (from, to, anywhere) => {
    if (whole && !anywhere && !(from === 0 && to === runs.length)) return;
    if (allowed.some(([start, end]) => start <= from && to <= end)) return;
    spans.push([token[runs[from].first].start, token[runs[to - 1].last].end]);
  });
  return spans;
}

/** Filters `text`: `matched` tells whether a banned word was found; `text` has the matches masked. */
export function applyChatFilter(filter: CompiledChatFilter, text: string): ChatFilterResult {
  if (!filter.enabled || !text) return { matched: false, text, spans: 0 };

  const codePoints = Array.from(text);
  const spans: Array<[number, number]> = [];
  for (const token of buildTokens(toUnits(codePoints))) spans.push(...matchToken(filter, token));
  if (spans.length === 0) return { matched: false, text, spans: 0 };

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }

  const out = codePoints.slice();
  for (const [from, to] of merged) for (let i = from; i <= to; i++) out[i] = filter.maskChar;
  return { matched: true, text: out.join(""), spans: merged.length };
}
