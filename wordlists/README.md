# Chat filter word lists (server only)

The chat filter (`src/modules/chat/chat-filter.ts`) masks or blocks the words exported from Unity in
`config.json > chat > filter > words`. The server also merges the bundled lists in this folder, per language, as
selected by `config.json > chat > filter > bundledLists` (default: `en`, `pt`, `ja`, `ko`, `zh`; `[]` turns them off).

| Folder | Content |
|--------|---------|
| `ldnoobw/<lang>.txt` | Unmodified copy of the LDNOOBW lists (see below). Refresh with `node tools/fetch-wordlists.mjs [commit]` (default: the pinned commit below). |
| `exclude/<lang>.txt` | Entries of the LDNOOBW list that are NOT filtered: ordinary words, game terms and neutral identity terms. |
| `extra/<lang>.txt` | Entries added by this project (common chat insults the LDNOOBW list lacks). |

Format: one entry per line, `#` starts a comment. Entries with spaces are skipped (the filter matches single words).
Words in Chinese, Japanese or Korean script match anywhere in the text, since those languages have no word boundaries.

Effective list per language = `ldnoobw` - `exclude` + `extra`. The server reads the folder `wordlists/` relative to its
working directory. The Unity client never ships these files: the Offline backend only uses the words configured in Unity.

## Third-party notice

`ldnoobw/` contains the "List of Dirty, Naughty, Obscene, and Otherwise Bad Words"
(https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words, commit
`5faf2ba42d7b1c0977169ec3611df25a3c08eb13`), © 2012-2020 Shutterstock, Inc., licensed under the Creative Commons
Attribution 4.0 International License (`ldnoobw/LICENSE`, https://creativecommons.org/licenses/by/4.0/).
Changes: this project does not modify those files; it filters entries out (`exclude/`) and adds its own (`extra/`)
when building the effective list at runtime.
