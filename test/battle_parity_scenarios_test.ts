import assert from "node:assert/strict";

import { buildParityScenarios } from "./parity/parity-scenarios";
import { runParityScenario } from "./parity/generate-fixtures";

describe("Battle parity scenarios", () => {
  const scenarios = buildParityScenarios(4);

  it("every scenario finishes and is deterministic (replays produce identical fixtures)", () => {
    for (const scenario of scenarios) {
      const first = runParityScenario(scenario);
      const second = runParityScenario(scenario);
      assert.deepEqual(second, first, scenario.name);
      const last = first.steps[first.steps.length - 1].result as any;
      assert.equal(last.finished, true, `${scenario.name} did not finish`);
    }
  });
});
