import fs from "fs";
import * as fsp from "fs/promises";

import type { StatsDTO } from "./DTO/characterCatalogDto";
import {
  LEADER_CONTENT_MODES,
  LEADER_SKILL_SCOPES,
  type LeaderContentMode,
  type LeaderSkillCatalog,
  type LeaderSkillDTO,
  type LeaderSkillScope,
} from "./DTO/leaderSkillCatalogDto";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";

let currentCatalog: LeaderSkillCatalog = { leaderSkills: [] };

const PLAIN_NAME = "leader_skills.json";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeScope(raw: unknown): LeaderSkillScope {
  if (typeof raw === "string" && LEADER_SKILL_SCOPES.includes(raw as LeaderSkillScope)) {
    return raw as LeaderSkillScope;
  }
  return "AllAllies";
}

function sanitizeStats(raw: any): Partial<StatsDTO> | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const out: Partial<StatsDTO> = {};
  for (const key of ["hp", "atk", "def", "spd", "sh", "cr", "cd", "res", "acc", "eva"] as const) {
    const value = raw[key];
    if (!isFiniteNumber(value)) continue;
    out[key] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeModeFilter(raw: unknown): LeaderContentMode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const modes = raw
    .filter((entry) => typeof entry === "string")
    .map((entry) => String(entry).trim())
    .filter((entry): entry is LeaderContentMode => (LEADER_CONTENT_MODES as readonly string[]).includes(entry));

  return modes.length > 0 ? Array.from(new Set(modes)) : undefined;
}

function sanitizeElementFilter(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function sanitizeLeaderSkill(raw: any): LeaderSkillDTO | null {
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id) return null;

  return {
    id,
    displayName: typeof raw?.displayName === "string" && raw.displayName.trim().length > 0
      ? raw.displayName.trim()
      : null,
    scope: sanitizeScope(raw?.scope),
    percentBonuses: sanitizeStats(raw?.percentBonuses),
    flatBonuses: sanitizeStats(raw?.flatBonuses),
    modeFilter: sanitizeModeFilter(raw?.modeFilter),
    elementFilter: sanitizeElementFilter(raw?.elementFilter),
  };
}

function normalizeCatalog(rawText: string): LeaderSkillCatalog {
  const parsed = JSON.parse(rawText);
  const array = Array.isArray(parsed?.leaderSkills) ? parsed.leaderSkills : [];
  if (!Array.isArray(parsed?.leaderSkills)) console.warn("[LeaderSkillCatalog] invalid format; expected { leaderSkills: [] }");

  return {
    leaderSkills: array.map(sanitizeLeaderSkill).filter(Boolean) as LeaderSkillDTO[],
  };
}

function loadInternal(warnIfMissing: boolean): LeaderSkillCatalog {
  try {
    const chosen = locateCatalogFile(PLAIN_NAME);
    if (!chosen) {
      const message = "[LeaderSkillCatalog] leader skill file not found in any of: " + JSON.stringify(configDirs());
      warnIfMissing ? console.warn(message) : console.log(message);
      currentCatalog = currentCatalog?.leaderSkills ? currentCatalog : { leaderSkills: [] };
      return currentCatalog;
    }

    currentCatalog = normalizeCatalog(fs.readFileSync(chosen, "utf8"));
    console.log("[LeaderSkillCatalog] loaded", currentCatalog.leaderSkills.length, "leader skills from:", chosen);
    return currentCatalog;
  } catch (error) {
    console.error("[LeaderSkillCatalog] load error:", error);
    currentCatalog = { leaderSkills: [] };
    return currentCatalog;
  }
}

export function loadLeaderSkillCatalogOnce(): LeaderSkillCatalog {
  if (currentCatalog.leaderSkills.length > 0) return currentCatalog;
  return loadInternal(true);
}

export function reloadLeaderSkillCatalog(): LeaderSkillCatalog {
  return loadInternal(false);
}

export async function reloadLeaderSkillCatalogFromFile(filePath: string): Promise<LeaderSkillCatalog> {
  currentCatalog = normalizeCatalog(await fsp.readFile(filePath, "utf8"));
  console.log("[LeaderSkillCatalog] reloaded from file:", filePath, "leaderSkills:", currentCatalog.leaderSkills.length);
  return currentCatalog;
}

export function getLeaderSkillCatalog(): LeaderSkillCatalog {
  return currentCatalog?.leaderSkills ? currentCatalog : { leaderSkills: [] };
}

export function getLeaderSkillById(id: string): LeaderSkillDTO | undefined {
  return getLeaderSkillCatalog().leaderSkills.find((entry) => entry.id === id);
}

