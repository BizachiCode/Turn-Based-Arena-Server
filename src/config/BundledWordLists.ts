// Server-only chat filter word lists (`wordlists/`, see wordlists/README.md): LDNOOBW per language minus the
// project's exclusions plus its additions. Read once per language and cached; the Unity client never ships them.

import fs from "node:fs";
import path from "node:path";

export const BUNDLED_WORD_LIST_LANGUAGES = ["en", "pt", "ja", "ko", "zh"] as const;

const cache = new Map<string, string[]>();

function readList(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      // The filter matches single words: phrases could never match, so they are skipped.
      .filter((line) => line.length > 0 && !/\s/u.test(line));
  } catch {
    return [];
  }
}

/** Effective bundled words of one language (`ldnoobw` - `exclude` + `extra`); empty for an unknown language. */
export function bundledWords(language: string, dir: string = path.resolve("./wordlists")): string[] {
  const key = `${dir}|${language}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (!(BUNDLED_WORD_LIST_LANGUAGES as readonly string[]).includes(language)) return [];

  const excluded = new Set(readList(path.join(dir, "exclude", `${language}.txt`)).map((word) => word.toLowerCase()));
  const words = readList(path.join(dir, "ldnoobw", `${language}.txt`)).filter((word) => !excluded.has(word.toLowerCase()));
  const result = [...new Set([...words, ...readList(path.join(dir, "extra", `${language}.txt`))])];
  cache.set(key, result);
  return result;
}

/** Languages selected by `chat.filter.bundledLists` (all when absent, none for `[]`; unknown codes are ignored). */
export function selectedBundledLanguages(raw: unknown): string[] {
  const value = raw && typeof raw === "object" ? (raw as { bundledLists?: unknown }).bundledLists : undefined;
  if (!Array.isArray(value)) return [...BUNDLED_WORD_LIST_LANGUAGES];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()))]
    .filter((item) => (BUNDLED_WORD_LIST_LANGUAGES as readonly string[]).includes(item));
}
