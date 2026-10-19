// Shared lookup rules for catalog files exported by Unity into CONFIG_DIR.

import fs from "node:fs";
import path from "node:path";

export function configDirs(): string[] {
  const configDir = path.resolve(process.env.CONFIG_DIR || "./game_config");
  const adminDir = path.resolve(process.env.ADMIN_STORAGE_DIR || configDir);
  return [...new Set([configDir, adminDir, path.resolve("./game_config")])];
}

function latestBundleDir(dir: string): string | null {
  try {
    const bundles = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("bundle_"))
      .map((entry) => ({ dir: path.join(dir, entry.name), time: fs.statSync(path.join(dir, entry.name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    return bundles[0]?.dir ?? null;
  } catch {
    return null;
  }
}

/**
 * Most recently modified existing file among `<dir>/<fileName>` (a Unity export, or the copy written by the config
 * import) and `<latest bundle>/<bundlePath>` (first config dir that has any). Every catalog in `src/config` uses this
 * rule; the server never writes catalog files on its own.
 *
 * @param bundlePath path of the file inside an imported `bundle_*` folder (default `fileName`; runes live in `runes/`).
 */
export function locateCatalogFile(fileName: string, bundlePath: string = fileName): string | null {
  for (const dir of configDirs()) {
    const bundle = latestBundleDir(dir);
    const candidates = [path.join(dir, fileName), ...(bundle ? [path.join(bundle, bundlePath)] : [])];
    let best: string | null = null;
    let bestTime = -Infinity;
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const time = fs.statSync(candidate).mtimeMs;
      if (time > bestTime) {
        best = candidate;
        bestTime = time;
      }
    }
    if (best) return best;
  }
  return null;
}
