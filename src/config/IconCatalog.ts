import fs from "fs";
import * as fsp from "fs/promises";
import path from "path";
import { configDirs, locateCatalogFile } from "./catalog-file-locator.js";

export type IconCfg = {
  id: string;
  name?: string;
  sprite?: string;
  unlocked?: boolean;
};

export type IconCatalog = { icons: IconCfg[] };

let _icons: IconCatalog = { icons: [] };

/** Parses `icons.json`: the root array exported by Unity. */
function normalizeIcons(rawText: string): IconCatalog {
  const parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed)) {
    console.warn("[IconConfig] invalid format; expected the exported root array");
    return { icons: [] };
  }
  return { icons: parsed as IconCfg[] };
}

export function loadIconCatalogOnce(): IconCatalog {
  return loadInternal(true);
}

export function reloadIconCatalog(): IconCatalog {
  return loadInternal(false);
}

/** Reload from a specific file path (used by ZIP import). */
export async function reloadIconCatalogFromFile(filePath: string): Promise<IconCatalog> {
  const raw = await fsp.readFile(filePath, "utf8");
  _icons = normalizeIcons(raw);
  console.log("[IconConfig] reloaded from file:", filePath, "items:", _icons.icons.length);
  return _icons;
}

function loadInternal(warnIfMissing: boolean): IconCatalog {
  try {
    const chosen = locateCatalogFile("icons.json");
    if (!chosen) {
      const msg = "[IconConfig] icons file not found in any of: " + JSON.stringify(configDirs());
      warnIfMissing ? console.warn(msg) : console.log(msg);
      _icons = _icons?.icons ? _icons : { icons: [] };
      return _icons;
    }

    const raw = fs.readFileSync(chosen, "utf8");
    _icons = normalizeIcons(raw);
    console.log("[IconConfig] loaded", _icons.icons.length, "icons from:", chosen);
    return _icons;
  } catch (e) {
    console.error("[IconConfig] load error:", e);
    _icons = { icons: [] };
    return _icons;
  }
}

export function getIconCatalog(): IconCatalog {
  return _icons?.icons ? _icons : { icons: [] };
}

export function getIconById(id: string): IconCfg {
  if (!id) throw new Error("Icon id is empty.");
  const lower = id.toLowerCase();
  const found = getIconCatalog().icons.find(x => (x.id ?? "").toLowerCase() === lower);
  if (!found) throw new Error(`Icon not found in catalog: ${id}`);
  return found;
}

