// Game-config catalogs exported by Unity: boot loading and live import (zip/json).

import AdmZip from "adm-zip";
import * as fsp from "node:fs/promises";
import path from "node:path";

import { GameServerConfigSchema } from "../../config/game-config.schema.js";
import { applyAndSaveConfig, getConfig, loadInitialConfig } from "../../config/LiveConfigCatalog.js";
import { loadCurrencyCatalogOnce, reloadCurrencyCatalogFromFile } from "../../config/CurrencyCatalog.js";
import { loadIconCatalogOnce, reloadIconCatalogFromFile } from "../../config/IconCatalog.js";
import { loadSummonCatalogOnce, reloadSummonCatalogFromFile } from "../../config/SummonCatalog.js";
import { loadCharacterCatalogOnce, reloadCharacterCatalogFromFile } from "../../config/CharacterCatalog.js";
import { loadLeaderSkillCatalogOnce, reloadLeaderSkillCatalogFromFile } from "../../config/LeaderSkillCatalog.js";
import { loadMapCatalogOnce, reloadMapCatalogFromFile } from "../../config/MapCatalog.js";
import { loadCombatFormulaCatalogOnce, reloadCombatFormulaCatalogFromFile } from "../../config/CombatFormulaCatalog.js";
import { loadRuneCatalogOnce, reloadRuneCatalogFromDir } from "../../config/RuneCatalog.js";
import { loadHomeCatalogOnce, reloadHomeCatalogFromFile } from "../../config/HomeCatalog.js";
import { createLogger } from "../../shared/logger.js";

const logger = createLogger("CatalogService");

/** One single-file catalog handled by the importer. */
export type CatalogDescriptor = {
  /** File name inside the exported bundle (also the copy kept in the config dir). */
  fileName: string;
  loadOnce: () => unknown;
  reloadFromFile: (filePath: string) => Promise<unknown>;
};

/** Built-in catalogs (extend with {@link CatalogService.register}). */
export const DEFAULT_CATALOGS: CatalogDescriptor[] = [
  { fileName: "currencies.json", loadOnce: loadCurrencyCatalogOnce, reloadFromFile: reloadCurrencyCatalogFromFile },
  { fileName: "icons.json", loadOnce: loadIconCatalogOnce, reloadFromFile: reloadIconCatalogFromFile },
  { fileName: "summons.json", loadOnce: loadSummonCatalogOnce, reloadFromFile: reloadSummonCatalogFromFile },
  { fileName: "characters.json", loadOnce: loadCharacterCatalogOnce, reloadFromFile: reloadCharacterCatalogFromFile },
  { fileName: "leader_skills.json", loadOnce: loadLeaderSkillCatalogOnce, reloadFromFile: reloadLeaderSkillCatalogFromFile },
  { fileName: "maps.json", loadOnce: loadMapCatalogOnce, reloadFromFile: reloadMapCatalogFromFile },
  { fileName: "combat_config.json", loadOnce: loadCombatFormulaCatalogOnce, reloadFromFile: reloadCombatFormulaCatalogFromFile },
  { fileName: "homes.json", loadOnce: loadHomeCatalogOnce, reloadFromFile: reloadHomeCatalogFromFile },
];

const RUNE_FILES = [
  "rune_sets.json",
  "rune_slot_rules.json",
  "rune_main_curves.json",
  "rune_substat_rolls.json",
  "rune_grinds.json",
  "rune_config.json",
];

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class CatalogService {
  private readonly catalogs: CatalogDescriptor[];

  constructor(
    private readonly configDir: string,
    catalogs: CatalogDescriptor[] = DEFAULT_CATALOGS,
  ) {
    this.catalogs = [...catalogs];
  }

  /** Adds a catalog handled by boot/import (e.g. `shop.json`). */
  register(descriptor: CatalogDescriptor): void {
    this.catalogs.push(descriptor);
  }

  /** Loads every catalog from disk. */
  async bootstrapOnStart(): Promise<void> {
    await loadInitialConfig();

    for (const catalog of this.catalogs) {
      try { catalog.loadOnce(); } catch (error) { logger.warn(`${catalog.fileName} load failed:`, (error as Error).message); }
    }
    try { loadRuneCatalogOnce(); } catch (error) { logger.warn("rune catalog load failed:", (error as Error).message); }
  }

  getCurrentConfig() {
    return getConfig();
  }

  /**
   * Imports a Unity export bundle (zip). Every recognized file is validated/reloaded and copied into the config dir
   * (what the next boot loads); `config.json` is mandatory.
   */
  async importZip(zipBuffer: Buffer) {
    const bundleDir = path.resolve(this.configDir, `bundle_${stamp()}`);
    await fsp.mkdir(bundleDir, { recursive: true });

    const zip = new AdmZip(zipBuffer);
    for (const entry of zip.getEntries()) {
      const target = path.resolve(bundleDir, entry.entryName);
      if (!target.startsWith(bundleDir + path.sep)) throw new Error(`Unsafe path in bundle: ${entry.entryName}`);
    }
    zip.extractAllTo(bundleDir, true);

    const imported: string[] = [];

    const configPath = path.join(bundleDir, "config.json");
    if (!(await exists(configPath))) throw new Error("Bundle is missing config.json");
    const parsedConfig = GameServerConfigSchema.parse(JSON.parse(await fsp.readFile(configPath, "utf8")));

    for (const catalog of this.catalogs) {
      const source = path.join(bundleDir, catalog.fileName);
      if (!(await exists(source))) continue;
      await catalog.reloadFromFile(source);
      await fsp.copyFile(source, path.join(this.configDir, catalog.fileName));
      imported.push(catalog.fileName);
    }

    const runeDir = (await exists(path.join(bundleDir, "runes"))) ? path.join(bundleDir, "runes") : bundleDir;
    const runeFiles = [];
    for (const fileName of RUNE_FILES) {
      if (await exists(path.join(runeDir, fileName))) runeFiles.push(fileName);
    }
    if (runeFiles.length > 0) {
      if (runeDir === bundleDir) {
        // Flat bundle layout: the rune loader reads `<dir>/runes/*.json`.
        await fsp.mkdir(path.join(bundleDir, "runes"), { recursive: true });
        for (const fileName of runeFiles) await fsp.copyFile(path.join(bundleDir, fileName), path.join(bundleDir, "runes", fileName));
      }
      await reloadRuneCatalogFromDir(bundleDir);
      for (const fileName of runeFiles) await fsp.copyFile(path.join(runeDir, fileName), path.join(this.configDir, fileName));
      imported.push(...runeFiles);
    }

    await applyAndSaveConfig(parsedConfig);
    imported.push("config.json");

    return { ok: true as const, imported: { dir: bundleDir, files: imported } };
  }

  /** Imports `config.json` alone (JSON body). */
  async importJson(jsonBody: unknown) {
    const parsedConfig = GameServerConfigSchema.parse(jsonBody);
    const saved = await applyAndSaveConfig(parsedConfig);
    return { ok: true as const, saved };
  }
}
