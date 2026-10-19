import {
  CombatFormulaSnapshot,
  ResolvedCombatFormula,
  createDefaultCombatFormulaSnapshot,
  resolveCombatFormula,
} from "../domain/combat-formula";

export interface CombatFormulaProvider {
  getSnapshot(): CombatFormulaSnapshot;
}

/** Provider returning a fixed snapshot. Partial snapshots are completed with defaults. */
export class StaticCombatFormulaProvider implements CombatFormulaProvider {
  private readonly snapshot: ResolvedCombatFormula;

  constructor(snapshot: CombatFormulaSnapshot = createDefaultCombatFormulaSnapshot()) {
    this.snapshot = resolveCombatFormula(snapshot);
  }

  getSnapshot(): ResolvedCombatFormula {
    return this.snapshot;
  }
}
