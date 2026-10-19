import fs from "fs";
import * as fsp from "fs/promises";
import {
  CombatFormulaSnapshot,
  createDefaultCombatFormulaSnapshot,
  normalizeCombatFormulaSnapshot,
} from "../modules/battle-core/domain/combat-formula";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";

let currentCombatFormula: CombatFormulaSnapshot = createDefaultCombatFormulaSnapshot();

/** Delegates to the battle-core normalizer so every engine field (and its default) survives a config import. */
function sanitizeCombatFormula(raw: unknown): CombatFormulaSnapshot {
  return normalizeCombatFormulaSnapshot(raw);
}

function normalizeCombatFormula(rawText: string): CombatFormulaSnapshot {
  return sanitizeCombatFormula(JSON.parse(rawText));
}

export function loadCombatFormulaCatalogOnce(): CombatFormulaSnapshot {
  return loadInternal(true);
}

export function reloadCombatFormulaCatalog(): CombatFormulaSnapshot {
  return loadInternal(false);
}

export async function reloadCombatFormulaCatalogFromFile(filePath: string): Promise<CombatFormulaSnapshot> {
  const raw = await fsp.readFile(filePath, "utf8");
  currentCombatFormula = normalizeCombatFormula(raw);
  console.log("[CombatFormulaCatalog] reloaded from file:", filePath);
  return currentCombatFormula;
}

function loadInternal(warnIfMissing: boolean): CombatFormulaSnapshot {
  try {
    const chosen = locateCatalogFile("combat_config.json");
    if (!chosen) {
      const message = "[CombatFormulaCatalog] combat config file not found in any of: " + JSON.stringify(configDirs());
      if (warnIfMissing) console.warn(message);
      else console.log(message);
      currentCombatFormula = currentCombatFormula ?? createDefaultCombatFormulaSnapshot();
      return currentCombatFormula;
    }

    const raw = fs.readFileSync(chosen, "utf8");
    currentCombatFormula = normalizeCombatFormula(raw);
    console.log("[CombatFormulaCatalog] loaded from:", chosen);
    return currentCombatFormula;
  } catch (error) {
    console.error("[CombatFormulaCatalog] load error:", error);
    currentCombatFormula = createDefaultCombatFormulaSnapshot();
    return currentCombatFormula;
  }
}

export function getCombatFormulaCatalog(): CombatFormulaSnapshot {
  return currentCombatFormula ?? createDefaultCombatFormulaSnapshot();
}

