// Downloads the LDNOOBW word lists used by the chat filter into wordlists/ldnoobw/ (see wordlists/README.md).
// Usage: node tools/fetch-wordlists.mjs [commit]   (default: the pinned commit below; "master" for the newest)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PINNED_COMMIT = "5faf2ba42d7b1c0977169ec3611df25a3c08eb13";
const LANGUAGES = ["en", "pt", "ja", "ko", "zh"];
const commit = process.argv[2] || PINNED_COMMIT;
const base = `https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/${commit}`;
const target = path.resolve("wordlists/ldnoobw");

await mkdir(target, { recursive: true });
for (const [remote, local] of [...LANGUAGES.map((lang) => [lang, `${lang}.txt`]), ["LICENSE", "LICENSE"]]) {
  const response = await fetch(`${base}/${remote}`);
  if (!response.ok) throw new Error(`${remote}: HTTP ${response.status}`);
  const text = await response.text();
  await writeFile(path.join(target, local), text);
  console.log(`${local}: ${text.split(/\r?\n/).filter(Boolean).length} lines`);
}
console.log(`LDNOOBW @ ${commit} -> ${target}. Update the commit in wordlists/README.md if it changed.`);
