import fs from "fs";
import * as fsp from "fs/promises";

import {
  AwakeningCostDTO,
  AwakeningReplacementDTO,
  AwakeningRewardsDTO,
  AwakeningStepDTO,
  AwakeningTuningDTO,
  CharacterCatalog,
  CharacterDTO,
  GrowthDTO,
  StarLevelStatsDTO,
  StarOverrideDTO,
  StatMultDTO,
  StatsDTO,
} from "./DTO/characterCatalogDto";
import {
  normalizeCharacterPassives,
  normalizeCharacterSkills,
} from "../modules/battle-core/types/battle-data-normalizers";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";
  
/* ---------- state ---------- */
let _chars: CharacterCatalog = { characters: [] };

/* ---------- paths ---------- */

/* ---------- ---------- */

function isNum(n: any): n is number { return typeof n === "number" && isFinite(n); }

function sanitizeStats(s: any): StatsDTO {
  const src = s || {};
  return {
    hp: isNum(src.hp) ? src.hp : 0,
    atk: isNum(src.atk) ? src.atk : 0,
    def: isNum(src.def) ? src.def : 0,
    spd: isNum(src.spd) ? src.spd : 0,
    sh:  isNum(src.sh)  ? src.sh  : 0,
    cr:  isNum(src.cr)  ? src.cr  : 0,
    cd:  isNum(src.cd)  ? src.cd  : 0,
    res: isNum(src.res) ? src.res : 0,
    acc: isNum(src.acc) ? src.acc : 0,
    eva: isNum(src.eva) ? src.eva : 0,
  };
}
function sanitizeGrowth(g: any): GrowthDTO {
  const src = g || {};
  return {
    hp: isNum(src.hp) ? src.hp : 0,
    atk: isNum(src.atk) ? src.atk : 0,
    def: isNum(src.def) ? src.def : 0,
    spd: isNum(src.spd) ? src.spd : 0,
    cr:  isNum(src.cr)  ? src.cr  : 0,
    cd:  isNum(src.cd)  ? src.cd  : 0,
    res: isNum(src.res) ? src.res : 0,
    acc: isNum(src.acc) ? src.acc : 0,
    eva: isNum(src.eva) ? src.eva : 0,
  };
}
function sanitizeStatMult(m: any): StatMultDTO {
  const src = m || {};
  return {
    hp: isNum(src.hp) ? src.hp : 1,
    atk: isNum(src.atk) ? src.atk : 1,
    def: isNum(src.def) ? src.def : 1,
    spd: isNum(src.spd) ? src.spd : 1,
    sh:  isNum(src.sh)  ? src.sh  : 1,
    cr:  isNum(src.cr)  ? src.cr  : 1,
    cd:  isNum(src.cd)  ? src.cd  : 1,
    res: isNum(src.res) ? src.res : 1,
    acc: isNum(src.acc) ? src.acc : 1,
    eva: isNum(src.eva) ? src.eva : 1,
  };
}
function sanitizeManualTables(arr: any): StarLevelStatsDTO[] {
  if (!Array.isArray(arr)) return [];
  const out: StarLevelStatsDTO[] = [];
  for (const table of arr) {
    if (!table || !isNum(table.star) || !Array.isArray(table.levels) || table.levels.length === 0) continue;
    out.push({ star: Math.max(1, Math.min(6, Math.floor(table.star))), levels: table.levels.map(sanitizeStats) });
  }
  return out;
}
function sanitizeStarOverride(o: any): StarOverrideDTO | null {
  if (!o || !isNum(o.star)) return null;
  return {
    star: Math.max(1, Math.min(6, Math.floor(o.star))),
    baseMul: sanitizeStatMult(o.baseMul),
    perLevel: sanitizeGrowth(o.perLevel),
  };
}
function sanitizeCosts(arr: any): AwakeningCostDTO[] {
  if (!Array.isArray(arr)) return [];
  const out: AwakeningCostDTO[] = [];
  for (const it of arr) {
    const id = typeof it?.currencyId === "string" ? it.currencyId.trim() : "";
    const amount = isNum(it?.amount) ? Math.max(0, Math.floor(it.amount)) : 0;
    if (id) out.push({ currencyId: id, amount });
  }
  return out;
}
function sanitizeTuning(t: any): AwakeningTuningDTO {
  const starOverrides: StarOverrideDTO[] = Array.isArray(t?.starOverrides)
    ? t.starOverrides.map(sanitizeStarOverride).filter(Boolean) as StarOverrideDTO[]
    : [];
  return {
    starOverrides,
    flatBonus: sanitizeStats(t?.flatBonus),
    perLevelBonus: sanitizeGrowth(t?.perLevelBonus),
    useCustomBaseStats: t?.useCustomBaseStats === true,
    baseStats: sanitizeStats(t?.baseStats),
    useManualStarLevelStats: t?.useManualStarLevelStats === true,
    manualStarLevelStats: sanitizeManualTables(t?.manualStarLevelStats),
  };
}
function sanitizeReplacements(raw: unknown): AwakeningReplacementDTO[] {
  if (!Array.isArray(raw)) return [];
  const out: AwakeningReplacementDTO[] = [];
  for (const entry of raw) {
    const from = typeof entry?.from === "string" ? entry.from.trim() : "";
    const to = typeof entry?.to === "string" ? entry.to.trim() : "";
    if (from && to) out.push({ from, to });
  }
  return out;
}
function sanitizeRewards(r: any): AwakeningRewardsDTO {
  return {
    leaderSkillId: (typeof r?.leaderSkillId === "string" && r.leaderSkillId.trim().length > 0) ? r.leaderSkillId.trim() : null,
    addSkillIds: Array.isArray(r?.addSkillIds) ? r.addSkillIds.filter((x: any) => typeof x === "string" && x.trim().length > 0).map((x: string) => x.trim()) : [],
    addPassiveIds: Array.isArray(r?.addPassiveIds) ? r.addPassiveIds.filter((x: any) => typeof x === "string" && x.trim().length > 0).map((x: string) => x.trim()) : [],
    replaceSkills: sanitizeReplacements(r?.replaceSkills),
    replacePassives: sanitizeReplacements(r?.replacePassives),
    extraFlatBonus: sanitizeStats(r?.extraFlatBonus),
  };
}
function sanitizeAwakeningStep(s: any, idx1: number): AwakeningStepDTO | null {
  if (!s) return null;
  const minLevel = isNum(s.minLevel) ? Math.max(1, Math.floor(s.minLevel)) : 1;
  const minStars = isNum(s.minStars) ? Math.max(1, Math.min(6, Math.floor(s.minStars))) : 1;
  return {
    index: Math.max(1, Math.floor(isNum(s.index) ? s.index : idx1)),
    minLevel,
    minStars,
    costs: sanitizeCosts(s.costs),
    tuning: sanitizeTuning(s.tuning),
    rewards: sanitizeRewards(s.rewards),
  };
}
function sanitizeCharacter(c: any): CharacterDTO {
  const starOverrides: StarOverrideDTO[] = Array.isArray(c?.starOverrides)
    ? c.starOverrides.map(sanitizeStarOverride).filter(Boolean) as StarOverrideDTO[]
    : [];

  const awakenings: AwakeningStepDTO[] = Array.isArray(c?.awakenings)
    ? c.awakenings
        .map((a: any, i: number) => sanitizeAwakeningStep(a, i + 1))
        .filter(Boolean) as AwakeningStepDTO[]
    : [];

  const passiveIds = Array.isArray(c?.passiveIds)
    ? c.passiveIds.filter((x: any) => typeof x === "string" && x.trim().length > 0).map((x: string) => x.trim())
    : [];

  const skillIds = Array.isArray(c?.skillIds)
    ? c.skillIds.filter((x: any) => typeof x === "string" && x.trim().length > 0).map((x: string) => x.trim())
    : [];

  const skills = normalizeCharacterSkills(c?.skills);
  const passives = normalizeCharacterPassives(c?.passives);

  return {
    id: typeof c?.id === "string" ? c.id : "",
    element: typeof c?.element === "string" ? c.element : (c?.element ?? null),
    naturalStars: isNum(c?.naturalStars) ? Math.max(1, Math.min(6, Math.floor(c.naturalStars))) : 1,

    baseStats: sanitizeStats(c?.baseStats),
    starOverrides,
    useManualStarLevelStats: c?.useManualStarLevelStats === true,
    manualStarLevelStats: sanitizeManualTables(c?.manualStarLevelStats),

    leaderSkillId: (typeof c?.leaderSkillId === "string" && c.leaderSkillId.trim().length > 0) ? c.leaderSkillId.trim() : null,
    passiveIds,
    skillIds,
    passives,
    skills,

    awakenings,
    skillUpMaterial: c?.skillUpMaterial === true,
  };
}

/* ---------- normalize ---------- */
function normalizeCharacters(rawText: string): CharacterCatalog {
  const parsed = JSON.parse(rawText);
  const arr: any[] | null = parsed && Array.isArray(parsed.characters) ? parsed.characters : null;

  if (!arr) {
    console.warn("[CharacterCatalog] invalid format; expected { characters: [] }");
    return { characters: [] };
  }

  const sane = arr.map(sanitizeCharacter).filter((c: CharacterDTO) => !!c.id);
  return { characters: sane };
}

/* ---------- API */
export function loadCharacterCatalogOnce(): CharacterCatalog { return loadInternal(true); }
export function reloadCharacterCatalog(): CharacterCatalog   { return loadInternal(false); }

export async function reloadCharacterCatalogFromFile(filePath: string): Promise<CharacterCatalog> {
  const raw = await fsp.readFile(filePath, "utf8");
  _chars = normalizeCharacters(raw);
  console.log("[CharacterCatalog] reloaded from file:", filePath, "characters:", _chars.characters.length);
  return _chars;
}

function loadInternal(warnIfMissing: boolean): CharacterCatalog {
  try {
    const chosen = locateCatalogFile("characters.json");
    if (!chosen) {
      const msg = "[CharacterCatalog] characters file not found in any of: " + JSON.stringify(configDirs());
      warnIfMissing ? console.warn(msg) : console.log(msg);
      _chars = _chars?.characters ? _chars : { characters: [] };
      return _chars;
    }

    const raw = fs.readFileSync(chosen, "utf8");
    _chars = normalizeCharacters(raw);
    console.log("[CharacterCatalog] loaded", _chars.characters.length, "characters from:", chosen);
    return _chars;
  } catch (e) {
    console.error("[CharacterCatalog] load error:", e);
    _chars = { characters: [] };
    return _chars;
  }
}

export function getCharacterCatalog(): CharacterCatalog { return _chars?.characters ? _chars : { characters: [] }; }
export function getCharacterById(id: string): CharacterDTO | undefined {
  return getCharacterCatalog().characters.find((c) => c.id === id);
}

