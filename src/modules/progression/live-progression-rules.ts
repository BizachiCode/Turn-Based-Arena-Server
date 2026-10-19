import {
  getEvolveRulesFromConfig,
  getPowerUpRulesFromConfig,
  getStarTiersFromConfig,
} from "../../config/LiveConfigCatalog.js";
import type { ProgressionRulesSource } from "./progression.rules.js";

/** Progression rules read from the live `config.json` snapshot (hot-reloaded by /admin/config). */
export const liveProgressionRules: ProgressionRulesSource = {
  starTiers: () => getStarTiersFromConfig(),
  powerUp: () => getPowerUpRulesFromConfig(),
  evolve: () => getEvolveRulesFromConfig(),
};
