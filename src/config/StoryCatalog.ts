// Server-side dialogue/tutorial catalog (`dialogues.json`, exported from the Unity DialogueSequenceDatabase): which
// sequences exist, what unlocks them (previous sequences, account level) and the rewards granted once when a player
// completes them. The dialogue text, portraits and tutorial steps stay in Unity. See docs/PROTOCOL.md `story`.
// camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys, emptyPayload, ShopPackPayloadSchema } from "./ShopCatalog.js";

const dialogueId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/);

export const StoryDialogueSchema = z.object({
  id: dialogueId,
  /** Sequences that must be completed first. */
  prerequisites: z.array(dialogueId).max(16).default([]),
  minAccountLevel: z.coerce.number().int().min(1).max(999).default(1),
  /** Story beat shown after a victory (`stage_clear:<stageId>` trigger): that stage must be cleared on any difficulty. */
  requiredStageClear: z.string().trim().min(1).max(64).nullish().transform((value) => value || null),
  /** Repeatable sequences can be played again; their rewards are still granted only once. */
  repeatable: z.boolean().default(false),
  /** Skipping a sequence still completes it; false = skipping forfeits the rewards. */
  rewardWhenSkipped: z.boolean().default(true),
  rewards: ShopPackPayloadSchema.default(emptyPayload()),
});

export const StoryCatalogSchema = z.object({
  /**
   * Sequences unknown to the catalog can still be completed (no prerequisites, no rewards) so plain story dialogues
   * work before an export; set false to reject them.
   */
  allowUnknownDialogues: z.boolean().default(true),
  dialogues: z.array(StoryDialogueSchema).max(2000).default([]),
});

export type StoryCatalog = z.infer<typeof StoryCatalogSchema>;
export type StoryDialogue = z.infer<typeof StoryDialogueSchema>;

let catalog: StoryCatalog = StoryCatalogSchema.parse({});
let byId = new Map<string, StoryDialogue>();

function index(next: StoryCatalog): StoryCatalog {
  const ids = new Set<string>();
  for (const dialogue of next.dialogues) {
    if (ids.has(dialogue.id)) throw new Error(`dialogues.json: duplicate id ${dialogue.id}`);
    ids.add(dialogue.id);
  }
  catalog = next;
  byId = new Map(next.dialogues.map((dialogue) => [dialogue.id, dialogue]));
  return catalog;
}

/** Parses and validates `dialogues.json` (array or `{ dialogues: [...] }`). */
export function parseStoryCatalog(rawText: string): StoryCatalog {
  const parsed = camelizeKeys(JSON.parse(rawText));
  return StoryCatalogSchema.parse(Array.isArray(parsed) ? { dialogues: parsed } : parsed);
}

export function getStoryCatalog(): StoryCatalog {
  return catalog;
}

export function getStoryDialogue(id: string): StoryDialogue | undefined {
  return byId.get(id);
}

/** Replaces the in-memory catalog (tests / programmatic setups). */
export function setStoryCatalog(next: StoryCatalog): void {
  index(next);
}

export function loadStoryCatalogOnce(): StoryCatalog {
  const file = locateCatalogFile("dialogues.json");
  if (!file) {
    console.warn("[StoryCatalog] dialogues.json not found; any dialogue id can be completed (no rewards).");
    return catalog;
  }
  index(parseStoryCatalog(fs.readFileSync(file, "utf8")));
  console.log(`[StoryCatalog] loaded ${catalog.dialogues.length} dialogues from: ${file}`);
  return catalog;
}

export async function reloadStoryCatalogFromFile(filePath: string): Promise<StoryCatalog> {
  index(parseStoryCatalog(await fsp.readFile(filePath, "utf8")));
  console.log(`[StoryCatalog] reloaded from: ${filePath}`);
  return catalog;
}

