// New-player quest book (`new_player_quests.json`, exported from the Unity NewPlayerQuestBook asset): ordered chapters
// of one-time quests for new summoners ("beginner missions"). A chapter unlocks once every quest of the
// previous chapter was claimed; each chapter may grant a completion reward. See docs/PROTOCOL.md `missions` →
// "New-player quests". camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { STAGE_DIFFICULTIES } from "../shared/kernel/types.js";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys, emptyPayload, ShopPackPayloadSchema, type ShopPackPayload } from "./ShopCatalog.js";

/**
 * Quest conditions (append new kinds at the end: the Unity `NewPlayerQuestKind` enum mirrors this order).
 * - Counted kinds add up the player activity (same events as the daily missions) since the book went live.
 * - `account_level`, `clear_stage`, `own_monsters`, `rune_level` and `equip_runes` are read from the player's state,
 *   so they also complete for things done before the quest was visible.
 */
export const NEWBIE_QUEST_KINDS = [
  "account_level",
  "clear_stage",
  "stage_clear",
  "dungeon_clear",
  "tower_clear",
  "arena_battle",
  "summon",
  "monster_powerup",
  "monster_evolve",
  "monster_awaken",
  "rune_upgrade",
  "energy_spent",
  "own_monsters",
  "rune_level",
  "equip_runes",
] as const;
export type NewbieQuestKind = (typeof NEWBIE_QUEST_KINDS)[number];

/** Kinds read from the player's state (everything else is a running count of activity). */
export const STATE_QUEST_KINDS: ReadonlySet<NewbieQuestKind> = new Set(["account_level", "clear_stage", "own_monsters", "rune_level", "equip_runes"]);

const int = (fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const configId = (max: number) => z.string().trim().min(1).max(max).regex(/^[A-Za-z0-9_.-]+$/);

/** Accepts the kind name or its C# enum ordinal. */
const questKind = z.preprocess(
  (raw) => (typeof raw === "number" && Number.isInteger(raw) ? NEWBIE_QUEST_KINDS[raw] ?? raw : raw),
  z.enum(NEWBIE_QUEST_KINDS),
);

/** Difficulty name or C# ordinal; empty = Easy. */
const difficulty = z.preprocess(
  (raw) => (typeof raw === "number" && Number.isInteger(raw) ? STAGE_DIFFICULTIES[raw] ?? raw : raw == null || raw === "" ? "Easy" : raw),
  z.enum(["Easy", "Normal", "Hard", "Hell"]),
);

const QuestSchema = z.object({
  id: configId(64),
  kind: questKind,
  /** Count / level to reach (`clear_stage`: always 1). */
  target: int(1, 1, 100_000_000),
  /** `clear_stage`: the stage to clear at `difficulty` or harder. */
  regionId: z.string().trim().max(64).default(""),
  stageId: z.string().trim().max(64).default(""),
  difficulty: difficulty.default("Easy"),
  /** `own_monsters`: minimum stars of the counted monsters (1..6). */
  stars: int(1, 1, 6),
  /** `rune_level`: minimum level of the counted runes (0..15). */
  runeLevel: int(0, 0, 15),
  rewards: ShopPackPayloadSchema.default(emptyPayload()),
});
export type NewbieQuestConfig = z.infer<typeof QuestSchema>;

const ChapterSchema = z.object({
  id: configId(40),
  quests: z.array(QuestSchema).min(1).max(50),
  /** Granted once every quest of the chapter was claimed (empty = none). */
  rewards: ShopPackPayloadSchema.default(emptyPayload()),
});
export type NewbieChapterConfig = z.infer<typeof ChapterSchema>;

const reward = (currencies: Array<{ currencyId: string; amount: number }>): ShopPackPayload => ({ ...emptyPayload(), currencies });

/** Sample book (used until a `new_player_quests.json` is exported). */
export const DEFAULT_NEWBIE_CHAPTERS: z.input<typeof ChapterSchema>[] = [{
  id: "chapter_1",
  quests: [
    { id: "np_summon_1", kind: "summon", target: 1, rewards: reward([{ currencyId: "GO", amount: 5000 }]) },
    { id: "np_stage_3", kind: "stage_clear", target: 3, rewards: reward([{ currencyId: "EN", amount: 20 }]) },
    { id: "np_level_5", kind: "account_level", target: 5, rewards: reward([{ currencyId: "DM", amount: 50 }]) },
  ],
  rewards: reward([{ currencyId: "DM", amount: 100 }]),
}];

export const NewbieQuestBookSchema = z.object({
  enabled: z.boolean().default(true),
  chapters: z.array(ChapterSchema).max(30).default(() => DEFAULT_NEWBIE_CHAPTERS.map((chapter) => ChapterSchema.parse(chapter))),
});
export type NewbieQuestBook = z.infer<typeof NewbieQuestBookSchema>;

let catalog: NewbieQuestBook = NewbieQuestBookSchema.parse({});

/** Parses and validates `new_player_quests.json` (throws on invalid data or duplicate ids). */
export function parseNewbieQuestBook(rawText: string): NewbieQuestBook {
  const result = NewbieQuestBookSchema.parse(camelizeKeys(JSON.parse(rawText)));
  const chapterIds = result.chapters.map((chapter) => chapter.id);
  if (new Set(chapterIds).size !== chapterIds.length) throw new Error("new_player_quests.json: duplicate chapter id");
  const questIds = result.chapters.flatMap((chapter) => chapter.quests.map((quest) => quest.id));
  if (new Set(questIds).size !== questIds.length) throw new Error("new_player_quests.json: duplicate quest id");
  for (const quest of result.chapters.flatMap((chapter) => chapter.quests)) {
    if (quest.kind === "clear_stage" && (!quest.regionId || !quest.stageId)) throw new Error(`new_player_quests.json: ${quest.id} needs regionId and stageId`);
  }
  return result;
}

export function getNewbieQuestBook(): NewbieQuestBook {
  return catalog;
}

/** Replaces the in-memory book (tests / programmatic setups). */
export function setNewbieQuestBook(next: NewbieQuestBook): void {
  catalog = next;
}

export function loadNewbieQuestBookOnce(): NewbieQuestBook {
  const file = locateCatalogFile("new_player_quests.json");
  if (!file) {
    console.warn("[NewbieQuests] new_player_quests.json not found; using the sample book.");
    return catalog;
  }
  catalog = parseNewbieQuestBook(fs.readFileSync(file, "utf8"));
  console.log(`[NewbieQuests] loaded ${catalog.chapters.length} chapters from: ${file}`);
  return catalog;
}

export async function reloadNewbieQuestBookFromFile(filePath: string): Promise<NewbieQuestBook> {
  catalog = parseNewbieQuestBook(await fsp.readFile(filePath, "utf8"));
  console.log(`[NewbieQuests] reloaded from: ${filePath}`);
  return catalog;
}

