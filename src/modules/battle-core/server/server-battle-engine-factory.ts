import { getCombatFormulaCatalog } from "../../../config/CombatFormulaCatalog";
import { BattleEngine } from "../application/battle-engine";
import { StaticCombatFormulaProvider } from "../application/combat-formula-provider";
import type { BattleRandom } from "../domain/battle-random";
import type { BattleRuleset } from "../rulesets/battle-ruleset";
import { PassiveRuntimeSystem } from "../systems/passive-runtime-system";
import { RuneSetRuntimeSystem } from "../systems/rune-set-runtime-system";

export function createServerBattleEngine(
  ruleset: BattleRuleset,
  options?: {
    rng?: BattleRandom;
  }
): BattleEngine {
  return new BattleEngine(ruleset, {
    combatFormulaProvider: new StaticCombatFormulaProvider(getCombatFormulaCatalog()),
    rng: options?.rng,
    runtimeSystems: [new RuneSetRuntimeSystem(), new PassiveRuntimeSystem()],
  });
}
