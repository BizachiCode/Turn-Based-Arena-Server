// Server-side social configuration (`social.json`, exported from the Unity SocialDefinition asset): friends list limits,
// private messages, real-time friendly battles and the reconnection window of the battle rooms.
// See docs/PROTOCOL.md `social` and docs/REALTIME_PVP.md. camelCase and PascalCase keys (JsonUtility output) are accepted.

import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";
import { locateCatalogFile } from "./catalog-file-locator.js";
import { camelizeKeys } from "./ShopCatalog.js";

/** Integer (numeric strings accepted) with a default for absent fields. */
const int = (fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const bool = (fallback: boolean) => z.boolean().default(fallback);

export const SocialConfigSchema = z.object({
  friends: z.object({
    enabled: bool(true),
    maxFriends: int(100, 1, 500),
    /** Requests a player may have waiting for an answer. */
    maxPendingOutgoing: int(50, 1, 200),
    /** Requests a player may receive before new ones are refused (`FRIEND_TARGET_REQUESTS_FULL`). */
    maxPendingIncoming: int(100, 1, 500),
    /** Players one account may block. */
    maxBlocked: int(200, 10, 1000),
    searchMinChars: int(3, 1, 16),
    searchMaxResults: int(20, 1, 50),
    /** A player counts as online with a presence heartbeat at most this old. */
    onlineWindowSeconds: int(60, 15, 600),
  }).prefault({}),

  directMessages: z.object({
    enabled: bool(true),
    /** Guild mates may message each other without being friends. Length, rate and mutes follow `config.json > chat`. */
    allowGuildMembers: bool(false),
    /** Newest lines kept per conversation (older ones are deleted on send). */
    historyPerConversation: int(200, 20, 1000),
    historyPageSize: int(50, 10, 100),
    /** Conversations returned by `dm/conversations`. */
    maxConversations: int(50, 5, 200),
  }).prefault({}),

  friendlyBattle: z.object({
    enabled: bool(true),
    /** Guild mates may challenge each other without being friends. */
    allowGuildMembers: bool(true),
    /** A challenge nobody answered expires after this. */
    challengeTtlSeconds: int(60, 10, 600),
    /** Both players must join the match room within this time, or the match is aborted. */
    joinTimeoutSeconds: int(30, 10, 120),
    /** Team selection inside the match room; on timeout the arena defense team is used. */
    prepareSeconds: int(60, 10, 300),
    /** Time to choose a skill; on timeout the server plays the unit with the AI. */
    turnSeconds: int(30, 5, 300),
    /** Turns of a disconnected player are played by the AI after this pause. */
    absentTurnDelaySeconds: int(3, 0, 30),
    /** A disconnected player may come back within this window; afterwards they lose by forfeit. */
    reconnectSeconds: int(90, 0, 600),
    turnLimit: int(60, 1, 500),
  }).prefault({}),

  battleRooms: z.object({
    /** PvE, dungeon, tower and arena battles: a dropped player may reconnect within this window (0 = no reconnection). */
    reconnectSeconds: int(45, 0, 600),
  }).prefault({}),
});

export type SocialConfig = z.infer<typeof SocialConfigSchema>;

let catalog: SocialConfig = SocialConfigSchema.parse({});

/** Parses and validates `social.json` (throws on invalid data). */
export function parseSocialConfig(rawText: string): SocialConfig {
  return SocialConfigSchema.parse(camelizeKeys(JSON.parse(rawText)));
}

export function getSocialConfig(): SocialConfig {
  return catalog;
}

/** Replaces the in-memory config (tests / programmatic setups). */
export function setSocialConfig(next: SocialConfig): void {
  catalog = next;
}

export function loadSocialConfigOnce(): SocialConfig {
  const file = locateCatalogFile("social.json");
  if (!file) {
    console.warn("[SocialConfig] social.json not found; using defaults.");
    return catalog;
  }
  catalog = parseSocialConfig(fs.readFileSync(file, "utf8"));
  console.log(`[SocialConfig] loaded from: ${file}`);
  return catalog;
}

export async function reloadSocialConfigFromFile(filePath: string): Promise<SocialConfig> {
  catalog = parseSocialConfig(await fsp.readFile(filePath, "utf8"));
  console.log(`[SocialConfig] reloaded from: ${filePath}`);
  return catalog;
}

