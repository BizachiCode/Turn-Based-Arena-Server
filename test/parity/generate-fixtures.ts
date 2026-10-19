/*
 * Parity fixtures: runs every parity scenario through the TypeScript engine / PvE session and writes the initial
 * state, the commands and every step result (events + state) as JSON, to compare another engine (such as the C# port
 * of the Unity Offline backend) step by step.
 *
 * Usage: npx tsx test/parity/generate-fixtures.ts [outputDir]
 * Default output: test/parity/fixtures (git-ignored)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { PveBattleSessionStepResult } from "../../src/modules/battle-core";
import { buildParityScenarios, createParitySession, type ParityCommand, type ParityScenario } from "./parity-scenarios";

export type ParityFixtureStep = {
  command: Exclude<ParityCommand, { type: "auto*" }>;
  result: Record<string, unknown>;
};

export type ParityFixture = {
  name: string;
  description: string;
  rulesetId: string;
  formula: unknown;
  initialState: unknown;
  playerSideId: string;
  enemySideId: string;
  totalWaves: number;
  pendingEnemyWaves: unknown;
  steps: ParityFixtureStep[];
};

/** Per-step state snapshot without static unit data (skills / passives). */
function stripStatic(state: any): any {
  const copy = structuredClone(state);
  for (const unit of Object.values<any>(copy.units)) {
    delete unit.skills;
    delete unit.passives;
    delete unit.skillIds;
    delete unit.passiveIds;
  }
  return copy;
}

/** States are recorded every few steps (and always on the last step) to keep fixtures small. */
const STATE_CHECKPOINT_INTERVAL = 4;

/**
 * AttackBar fixtures keep the shape they had before the turn order systems existed: the `turnOrder` formula section
 * and the step result's `turnOrder` / `actorOptions` are only written for the round modes (the C# replay omits them
 * the same way).
 */
function serializeResult(result: PveBattleSessionStepResult, withState: boolean, roundMode: boolean): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    accepted: result.accepted,
    error: result.error ?? null,
    awaitingPlayerInput: result.awaitingPlayerInput,
    activeUnitId: result.activeUnitId,
    activeSideId: result.activeSideId,
    currentWaveIndex: result.currentWaveIndex,
    totalWaves: result.totalWaves,
    phase: result.phase,
    turn: result.turn,
    round: result.round,
    finished: result.finished,
    winnerSideId: result.winnerSideId,
    finishedReason: result.finishedReason,
    victory: result.victory,
    actionOptions: result.actionOptions,
    actorOptions: roundMode ? result.actorOptions : undefined,
    turnOrder: roundMode ? result.turnOrder : undefined,
    events: result.events,
    state: withState ? stripStatic(result.state) : undefined,
  }));
}

export function runParityScenario(scenario: ParityScenario): ParityFixture {
  const session = createParitySession(scenario);
  const roundMode = scenario.formula.turnOrder.mode !== "AttackBar";
  const steps: ParityFixtureStep[] = [];

  const run = (command: Exclude<ParityCommand, { type: "auto*" }>): PveBattleSessionStepResult => {
    let result: PveBattleSessionStepResult;
    switch (command.type) {
      case "start": result = session.start(); break;
      case "auto": result = session.usePlayerAuto(); break;
      case "surrender": result = session.surrender(); break;
      case "skill": result = session.usePlayerSkill({ actorId: command.actorId, skillId: command.skillId, targetId: command.targetId }); break;
    }
    steps.push({ command, result: serializeResult(result, steps.length % STATE_CHECKPOINT_INTERVAL === 0 || result.finished, roundMode) });
    return result;
  };

  let last: PveBattleSessionStepResult | null = null;
  for (const command of scenario.script) {
    if (command.type === "auto*") {
      const max = command.max ?? 400;
      for (let i = 0; i < max && last && !last.finished && last.awaitingPlayerInput; i++) last = run({ type: "auto" });
      continue;
    }
    last = run(command);
  }

  return JSON.parse(JSON.stringify({
    name: scenario.name,
    description: scenario.description,
    rulesetId: scenario.rulesetId,
    formula: roundMode ? scenario.formula : { ...scenario.formula, turnOrder: undefined },
    initialState: scenario.initialState,
    playerSideId: scenario.playerSideId,
    enemySideId: scenario.enemySideId,
    totalWaves: scenario.totalWaves,
    pendingEnemyWaves: scenario.pendingEnemyWaves,
    steps,
  }));
}

function main(): void {
  const outputDir = path.resolve(process.argv[2] ?? path.join(__dirname, "fixtures"));
  fs.mkdirSync(outputDir, { recursive: true });
  for (const file of fs.readdirSync(outputDir)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(outputDir, file));
  }

  const summary: string[] = [];
  for (const scenario of buildParityScenarios()) {
    const fixture = runParityScenario(scenario);
    const last = fixture.steps[fixture.steps.length - 1]?.result as any;
    const eventCount = fixture.steps.reduce((sum, step) => sum + ((step.result.events as unknown[])?.length ?? 0), 0);
    fs.writeFileSync(path.join(outputDir, `${scenario.name}.json`), JSON.stringify(fixture));
    summary.push(`${scenario.name}: ${fixture.steps.length} steps, ${eventCount} events, finished=${last?.finished} winner=${last?.winnerSideId} reason=${last?.finishedReason}`);
  }

  console.log(summary.join("\n"));
  console.log(`Wrote ${summary.length} fixtures to ${outputDir}`);
}

if (require.main === module) main();
