// Server-side guild configuration (`guild.json`, exported from the Unity GuildDefinition asset): name/text limits,
// member and officer caps, join requests, emblems, tags, the creation cost and the guild quests (daily member quests
// and weekly guild chests). See docs/PROTOCOL.md `guild`.
// camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys, emptyPayload, ShopPackPayloadSchema, type ShopPackPayload } from "./ShopCatalog.js";

/** Integer (numeric strings accepted) with a default for absent fields. */
const int = (fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const configId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/);

/** Emblems and tags of the sample content (used until a `guild.json` is exported). */
export const DEFAULT_GUILD_ICON_IDS = [
  "emblem_lion", "emblem_dragon", "emblem_phoenix", "emblem_wolf", "emblem_swords", "emblem_tree", "emblem_moon", "emblem_star",
  "emblem_skull", "emblem_crown", "emblem_kraken", "emblem_rune", "emblem_eagle", "emblem_bear", "emblem_flame", "emblem_lightning",
];
export const DEFAULT_GUILD_TAG_IDS = ["casual", "competitive", "active", "beginners", "helpful", "arena", "pve", "social"];

/** Player actions counted by the guild quests (append new kinds at the end: the Unity enum mirrors this order). */
export const GUILD_QUEST_KINDS = ["stage_clear", "arena_battle", "summon", "rune_upgrade", "monster_powerup"] as const;
export type GuildQuestKind = (typeof GUILD_QUEST_KINDS)[number];

/** Accepts the kind name or its C# enum ordinal. */
const questKind = z.preprocess(
  (raw) => (typeof raw === "number" && Number.isInteger(raw) ? GUILD_QUEST_KINDS[raw] ?? raw : raw),
  z.enum(GUILD_QUEST_KINDS),
);

const GuildDailyQuestSchema = z.object({
  id: configId,
  kind: questKind,
  target: int(1, 1, 1_000_000),
  guildPoints: int(10, 0, 100_000),
  rewards: ShopPackPayloadSchema.default(emptyPayload()),
});

const GuildChestSchema = z.object({
  id: configId,
  points: int(100, 1, 10_000_000),
  rewards: ShopPackPayloadSchema.default(emptyPayload()),
});

const reward = (currencies: Array<{ currencyId: string; amount: number }>, extra: Partial<ShopPackPayload> = {}): ShopPackPayload =>
  ({ ...emptyPayload(), currencies, ...extra });

/** Daily quests of the sample content (used until a `guild.json` with quests is exported). */
export const DEFAULT_GUILD_DAILY_QUESTS: z.input<typeof GuildDailyQuestSchema>[] = [
  { id: "daily_stage_clear", kind: "stage_clear", target: 5, guildPoints: 20, rewards: reward([{ currencyId: "GO", amount: 5000 }]) },
  { id: "daily_arena", kind: "arena_battle", target: 3, guildPoints: 20, rewards: reward([{ currencyId: "GO", amount: 3000 }, { currencyId: "AW", amount: 1 }]) },
  { id: "daily_summon", kind: "summon", target: 1, guildPoints: 10, rewards: reward([{ currencyId: "DM", amount: 10 }]) },
  { id: "daily_rune_upgrade", kind: "rune_upgrade", target: 3, guildPoints: 10, rewards: reward([{ currencyId: "GO", amount: 4000 }]) },
  { id: "daily_powerup", kind: "monster_powerup", target: 1, guildPoints: 10, rewards: reward([{ currencyId: "EN", amount: 10 }]) },
];

/** Weekly chests of the sample content. */
export const DEFAULT_GUILD_CHESTS: z.input<typeof GuildChestSchema>[] = [
  { id: "chest_bronze", points: 300, rewards: reward([{ currencyId: "GO", amount: 10000 }]) },
  { id: "chest_silver", points: 800, rewards: reward([{ currencyId: "DM", amount: 50 }]) },
  { id: "chest_gold", points: 1500, rewards: reward([{ currencyId: "mystic_scroll_cur", amount: 1 }]) },
  { id: "chest_legend", points: 3000, rewards: reward([{ currencyId: "DM", amount: 100 }], { runes: [{ setId: null, slot: null, tier: 5, quality: null, quantity: 1 }] }) },
];

export const GuildQuestConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Daily quests and weekly chests reset at this UTC hour. */
  resetHourUtc: int(0, 0, 23),
  /** First day of the chest week (0 = Sunday, 1 = Monday). */
  weekStartsOn: int(1, 0, 6),
  /** Personal daily quests of every member: `target` actions of `kind`; claiming adds `guildPoints` to the guild week. */
  daily: z.array(GuildDailyQuestSchema).max(20).default(() => DEFAULT_GUILD_DAILY_QUESTS.map((quest) => GuildDailyQuestSchema.parse(quest))),
  /** Weekly chests: every member may claim each one once per week when the guild's week points reach `points`. */
  chests: z.array(GuildChestSchema).max(10).default(() => DEFAULT_GUILD_CHESTS.map((chest) => GuildChestSchema.parse(chest))),
});

export type GuildQuestConfig = z.infer<typeof GuildQuestConfigSchema>;
export type GuildDailyQuest = GuildQuestConfig["daily"][number];
export type GuildChest = GuildQuestConfig["chests"][number];

export const GuildConfigSchema = z.object({
  minNameLength: int(3, 1, 32),
  maxNameLength: int(20, 3, 32),
  maxDescriptionLength: int(120, 0, 255),
  maxNoticeLength: int(120, 0, 255),
  maxMembers: int(30, 2, 100),
  /** Officers besides the leader. */
  maxOfficers: int(3, 0, 50),
  /** Tags a guild may pick. */
  maxTags: int(3, 0, 10),
  /** Pending join requests a player may have at the same time. */
  maxPendingRequestsPerUser: int(3, 1, 20),
  /** Join requests older than this are ignored and cleaned up. */
  requestExpirationHours: int(48, 1, 720),
  forbiddenCharacters: z.array(z.string().max(8)).default(["@", "#", "$", "%", "&", "*", "!", "/"]),
  autoCapitalizeName: z.boolean().default(true),
  allowRichTextInDescription: z.boolean().default(false),
  /** Emblems; only `isDefault` ones can be picked (others are reserved for future unlocks). */
  icons: z.array(z.object({ id: configId, isDefault: z.boolean().default(true) }))
    .default(DEFAULT_GUILD_ICON_IDS.map((id) => ({ id, isDefault: true }))),
  tags: z.array(z.object({ id: configId })).default(DEFAULT_GUILD_TAG_IDS.map((id) => ({ id }))),
  /** Price of a new guild (null = free). */
  creationCost: z.object({ currencyId: z.string().min(1), amount: int(0, 0) }).nullable().default({ currencyId: "GO", amount: 10000 }),
  /** Account level required to create a guild. */
  minLevelToCreate: int(3, 1),
  quests: GuildQuestConfigSchema.default(() => GuildQuestConfigSchema.parse({})),
});

export type GuildConfig = z.infer<typeof GuildConfigSchema>;

let catalog: GuildConfig = GuildConfigSchema.parse({});

/** Parses and validates `guild.json` (throws on invalid data; min > max lengths are rejected). */
export function parseGuildConfig(rawText: string): GuildConfig {
  const result = GuildConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
  if (result.minNameLength > result.maxNameLength) throw new Error("guild.json: minNameLength > maxNameLength");
  if (result.icons.filter((icon) => icon.isDefault).length === 0) throw new Error("guild.json: no selectable icon (isDefault)");
  const questIds = [...result.quests.daily.map((quest) => quest.id), ...result.quests.chests.map((chest) => chest.id)];
  if (new Set(questIds).size !== questIds.length) throw new Error("guild.json: duplicate quest/chest id");
  return result;
}

export function getGuildConfig(): GuildConfig {
  return catalog;
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setGuildConfig(next: GuildConfig): void {
  catalog = next;
}

export function loadGuildConfigOnce(): GuildConfig {
  const file = locateCatalogFile("guild.json");
  if (!file) {
    console.warn("[GuildConfig] guild.json not found; using defaults.");
    return catalog;
  }
  catalog = parseGuildConfig(fs.readFileSync(file, "utf8"));
  console.log(`[GuildConfig] loaded ${catalog.icons.length} emblems / ${catalog.tags.length} tags from: ${file}`);
  return catalog;
}

export async function reloadGuildConfigFromFile(filePath: string): Promise<GuildConfig> {
  catalog = parseGuildConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[GuildConfig] reloaded from: ${filePath}`);
  return catalog;
}

