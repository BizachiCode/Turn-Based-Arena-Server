// src/config/LiveConfigCatalog.ts
import fs from "fs/promises";
import path from "path";
import { GameServerConfig, GameServerConfigSchema } from "./game-config.schema.js";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { normalizeChatFilterConfig, type ChatFilterConfig } from "../modules/chat/chat-filter.js";
import { bundledWords, selectedBundledLanguages } from "./BundledWordLists.js";
import { normalizeReportRules, type ReportRules } from "../modules/report/report.rules.js";
import { normalizeGuaranteedSummons, type GuaranteedSummons } from "../modules/summon/summon.guaranteed.js";

const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || "./game_config");
const FILE_NAME = "config.json";

/** In-memory copy of the last validated config (saved to CONFIG_DIR/config.json by every import). */
let currentConfig: GameServerConfig | null = null;

/** Returns the current in-memory config, or null if not loaded yet. */
export function getConfig(): GameServerConfig | null {
  return currentConfig;
}

/**
 * Applies a validated config to memory and writes it to CONFIG_DIR/config.json (what the next boot loads).
 * Use this after a successful import (ZIP or JSON).
 */
export async function applyAndSaveConfig(cfg: GameServerConfig) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const filePath = path.join(CONFIG_DIR, FILE_NAME);
  await fs.writeFile(filePath, JSON.stringify(cfg, null, 2), "utf8");
  currentConfig = cfg;
  return { path: filePath };
}

/**
 * Loads the config on server boot: the newest of `config.json` (a Unity file export or the last import) and the last
 * bundle copy, like every other catalog. If no file exists, keeps the config null.
 */
export async function loadInitialConfig() {
  try {
    const file = locateCatalogFile(FILE_NAME);
    if (!file) throw new Error("config.json not found");
    const raw = await fs.readFile(file, "utf8");

    const parsed = GameServerConfigSchema.parse(JSON.parse(raw));
    currentConfig = parsed;
    console.log("[LiveConfig] loaded:", file);
  } catch {
    console.warn("[LiveConfig] no initial config; using null.");
    currentConfig = null;
  }
}

/* -----------------------------------------------------------------------------
 * Lightweight accessors for services
 * These helpers safely read the normalized config and provide sane defaults,
 * so gameplay services don't need to guard for missing fields.
 * -------------------------------------------------------------------------- */

/** Account EXP curve, EXP per energy, level-up rewards and refills. */
export function getAccountExpFromConfig() {
  const exp = getConfig()?.gameplay?.accountExp;
  return {
    maxLevel: exp?.maxLevel ?? 50,
    expPerLevel: exp?.expPerLevel ?? [],
    expPerEnergy: exp?.expPerEnergy ?? 10,
    levelUpRewards: exp?.levelUpRewards ?? [],
    refillOnLevelUp: exp?.refillOnLevelUp ?? [],
  };
}

/** Player capacity (bag/storage) with defensive defaults. */
/** Monster selling and slot purchases (`gameplay.monsterSell`, `gameplay.capacityExpansion`, `gameplay.playerCapacity`). */
export function getRosterRulesFromConfig() {
  const gameplay = getConfig()?.gameplay;
  const capacity = getPlayerCapacityFromConfig();
  const sell = gameplay?.monsterSell;
  const expansion = gameplay?.capacityExpansion;
  const rule = (raw: { step?: number; currencyId?: string; costBase?: number; costIncrement?: number } | undefined, initial: number, max: number, step: number, base: number) => ({
    step: raw?.step ?? step,
    currencyId: raw?.currencyId ?? "GO",
    costBase: raw?.costBase ?? base,
    costIncrement: raw?.costIncrement ?? 10000,
    initial,
    max,
  });
  return {
    sell: {
      currencyId: sell?.currencyId ?? "GO",
      priceByStars: sell?.priceByStars ?? [0, 300, 800, 2000, 6000, 20000, 60000],
      pricePerLevel: sell?.pricePerLevel ?? 50,
    },
    expansion: {
      bag: rule(expansion?.bag, capacity.bagInit, capacity.bagMax, 5, 20000),
      storage: rule(expansion?.storage, capacity.storageInit, capacity.storageMax, 25, 30000),
    },
  };
}

export function getPlayerCapacityFromConfig() {
  const pc = getConfig()?.gameplay?.playerCapacity;
  return {
    bagInit: pc?.initialBagCapacity ?? 100,
    bagMax: pc?.maxBagCapacity ?? 500,
    storageInit: pc?.initialStorageCapacity ?? 500,
    storageMax: pc?.maxStorageCapacity ?? 2000,
  };
}

/**
 * NEW: Power-Up rules exported by the client.
 * Services can use this to price/validate and to compute EXP yields.
 */
export function getPowerUpRulesFromConfig() {
  const pu = getConfig()?.gameplay?.powerUp;
  return {
    currencyId: pu?.currencyId ?? "GO",
    costPerFodderStarUnit: pu?.costPerFodderStarUnit ?? 600,
    expMultiplierByStars: Array.isArray(pu?.expMultiplierByStars) ? pu!.expMultiplierByStars : [],
    minFodderBaseLevel: pu?.minFodderBaseLevel ?? 2,
    expYieldMode: pu?.expYieldMode ?? "AccumulatedToLevel",
  };
}

/**
 * NEW: Evolve rules exported by the client.
 * Services can use this to price/validate evolve attempts.
 */
export function getEvolveRulesFromConfig() {
  const ev = getConfig()?.gameplay?.evolve;
  const steps = Array.isArray(ev?.steps) ? ev!.steps : [];
  // Optional: keep steps sorted by from/to stars for stable lookups
  steps.sort((a, b) => (a.fromStars - b.fromStars) || (a.toStars - b.toStars));
  return {
    currencyId: ev?.currencyId ?? "GO",
    costPerStarUnit: ev?.costPerStarUnit ?? 600,
    steps,
  };
}

/** Optional helper: Star tiers table (max level & exp per tier). */
export function getStarTiersFromConfig() {
  const tiers = getConfig()?.gameplay?.starTiers ?? [];
  // Keep a normalized, sorted copy (1..6)
  return [...tiers].sort((a, b) => a.stars - b.stars);
}

/** Minutes a paid stage ticket stays usable (`config.json > gameplay.stageStartTicketMinutes`, default 30). */
export function getStageStartTicketMinutesFromConfig(): number {
  return getConfig()?.gameplay?.stageStartTicketMinutes ?? 30;
}

/** Nickname rules (`config.json > profile.nickname`, with defaults). */
export function getNicknameRulesFromConfig() {
  const nick = getConfig()?.profile?.nickname;
  return {
    minLength: nick?.minLength ?? 3,
    maxLength: nick?.maxLength ?? 25,
    canUseSpecialChar: nick?.canUseSpecialChar ?? true,
  };
}

export function getChatRulesFromConfig() {
  const chat = getConfig()?.chat as any | undefined;

  const message = chat?.message || {};
  const directory = chat?.directory || {};
  const clientAntiSpam = chat?.clientAntiSpam || {};
  const serverRate = chat?.serverRate || {};

  return {
    msgMin: Number(message.minLength ?? 1),
    msgMax: Number(message.maxLength ?? 80),

    dirInitialPool: Number(directory.initialPool ?? 3),
    dirMaxPool: Number(directory.maxPool ?? 50),
    dirRecommended: Number(directory.recommendedPerChannel ?? 30),

    clientWindowSec: Number(clientAntiSpam.windowSeconds ?? 60),
    clientMaxInWindow: Number(clientAntiSpam.maxMessagesInWindow ?? 6),

    rateTokensPer10s: Number(serverRate.tokensPer10s ?? 8),
    rateBurst: Number(serverRate.burst ?? 12),
    userWindowSec: Number(serverRate.userWindowSeconds ?? 60),
    userMaxInWindow: Number(serverRate.userMaxMessagesInWindow ?? 20),
    dupMuteBaseSec: Number(serverRate.duplicateMuteBaseSeconds ?? 10)
  };
}

/** Memoizes a normalizer on the identity of the raw config object, so per-message callers get a stable result. */
function memoizedByRaw<T>(read: () => unknown, normalize: (raw: unknown) => T): () => T {
  let lastRaw: unknown;
  let last: T | undefined;
  return () => {
    const raw = read();
    if (last === undefined || raw !== lastRaw) {
      lastRaw = raw;
      last = normalize(raw);
    }
    return last;
  };
}

/**
 * Chat word filter (`config.json > chat > filter`), safe defaults (disabled) when absent. Same object until the config
 * reloads. The words exported from Unity are merged with the server-only bundled lists (`filter.bundledLists`).
 */
export const getChatFilterConfigFromConfig = memoizedByRaw<ChatFilterConfig>(
  () => (getConfig()?.chat as { filter?: unknown } | undefined)?.filter,
  (raw) => {
    const config = normalizeChatFilterConfig(raw);
    const bundled = selectedBundledLanguages(raw).flatMap((language) => bundledWords(language));
    return { ...config, words: [...new Set([...config.words, ...bundled])] };
  },
);

/** Tutorial guaranteed summons (`config.json > tutorial`), none when absent. */
export const getGuaranteedSummonsFromConfig = memoizedByRaw<GuaranteedSummons>(
  () => (getConfig() as { tutorial?: unknown } | null)?.tutorial,
  normalizeGuaranteedSummons,
);

/** Player report tuning (`config.json > reports`), defaults when absent. */
export const getReportRulesFromConfig = memoizedByRaw<ReportRules>(
  () => (getConfig() as { reports?: unknown } | null)?.reports,
  normalizeReportRules,
);
