/*
 * Smoke battles: every character of the loaded catalog fights in several auto-play battles (AI on both sides) in every
 * turn-order mode. Reports exceptions, battles that hit the step limit, and the biggest single hits, so a new balance
 * sheet can be checked before play-testing. Local only: no network, no database.
 *
 * Usage: npx tsx tools/sim/smoke-battles.ts [battlesPerMode=120] [teamSize=4]
 */
import { loadCharacterCatalogOnce, getCharacterCatalog } from "../../src/config/CharacterCatalog";
import { loadLeaderSkillCatalogOnce } from "../../src/config/LeaderSkillCatalog";
import {
  BattleEngine, PassiveRuntimeSystem, PveBattleRuleset, PveBattleSession, RuneSetRuntimeSystem, SeededBattleRandom,
  StaticCombatFormulaProvider, createBattleState, createDefaultCombatFormulaSnapshot, normalizeCombatFormulaSnapshot,
} from "../../src/modules/battle-core";

const MODES = ["AttackBar", "SpeedRounds", "AlternatingSides", "TeamPhase"] as const;
const MAX_STEPS = 600;

const battlesPerMode = Number(process.argv[2] ?? 120);
const teamSize = Number(process.argv[3] ?? 4);
const trace = process.argv[4] ?? ""; // battle id to print the end of


loadCharacterCatalogOnce();
loadLeaderSkillCatalogOnce();
const roster = getCharacterCatalog().characters.filter((c: any) => !c.skillUpMaterial && (c.skills?.length ?? 0) > 0);

type Hit = { amount: number; ratio: number; actor: string; skill: string; target: string; mode: string };
const errors: string[] = [];
const stalled: string[] = [];
const hits: Hit[] = [];
const appearances = new Map<string, number>();
let finished = 0;
let totalSteps = 0;

for (const mode of MODES) {
  const formula = normalizeCombatFormulaSnapshot({ ...(createDefaultCombatFormulaSnapshot() as any), turnOrder: { mode, teamPhaseSkipThreshold: 0.5 } });
  const rng = new SeededBattleRandom(`smoke-${mode}`);
  // walk the roster in shuffled order so every character appears; awakened and base forms alternate
  let deck: any[] = [];
  const draw = () => {
    if (deck.length === 0) deck = [...roster].sort(() => rng.next() - 0.5);
    return deck.pop();
  };
  for (let b = 0; b < battlesPerMode; b++) {
    const battleId = `${mode}-${b}`;
    const units: any[] = [];
    const ids: string[] = [];
    for (const side of ["players", "enemies"]) {
      for (let i = 0; i < teamSize; i++) {
        const character = draw();
        const unitId = `${side[0]}${i}_${character.id}`;
        ids.push(character.id);
        appearances.set(character.id, (appearances.get(character.id) ?? 0) + 1);
        const maxLevels: Record<string, number> = {};
        for (const s of character.skills ?? []) maxLevels[s.id] = s.maxSkillLevel ?? 5;
        units.push({
          unitId, sideId: side, character, star: 6, level: 50, awakeningIndex: (b + i) % 2,
          skillLevels: maxLevels, isLeader: i === 0, line: i < 2 ? "front" : "back",
        });
      }
    }
    try {
      const state = createBattleState({ battleId, mode: "pve", rulesetId: "pve-default", combatFormula: formula, units, seed: battleId } as any);
      const engine = new BattleEngine(new PveBattleRuleset(), {
        combatFormulaProvider: new StaticCombatFormulaProvider(formula),
        runtimeSystems: [new RuneSetRuntimeSystem(), new PassiveRuntimeSystem()],
      });
      const session = new PveBattleSession({
        state, pendingEnemyWaves: [], playerSideId: "players", enemySideId: "enemies",
        currentWaveIndex: 0, totalWaves: 1, engine,
      } as any);
      let result = session.start();
      let steps = 0;
      while (!result.finished && steps < MAX_STEPS) {
        result = session.usePlayerAuto();
        steps++;
        for (const e of result.events as any[]) {
          if (e.type !== "damage_applied" && e.type !== "damage") continue;
          const amount = Number(e.amount ?? e.damage ?? e.value ?? 0);
          const target = result.state.units[e.targetId ?? e.unitId];
          if (!target || !Number.isFinite(amount)) continue;
          hits.push({ amount, ratio: amount / Math.max(1, target.maxHp), actor: String(e.sourceId ?? e.actorId ?? "?"),
                      skill: String(e.skillId ?? "?"), target: target.characterId, mode });
        }
      }
      if (battleId === trace) {
        const st = result.state;
        console.log("TRACE", battleId, "turn", (result as any).turn, "accepted", result.accepted, "error", (result as any).error, "phase", (result as any).phase, "awaiting", result.awaitingPlayerInput, "active", (result as any).activeUnitId, "units:");
        for (const u of Object.values<any>(st.units)) console.log("  ", u.unitId, u.currentHp + "/" + u.maxHp, "bar", u.turnBar, "/", u.turnThreshold, "spd", u.stats?.spd, (u.statuses ?? []).map((x: any) => `${x.status ?? x.id}(${x.remainingTurns ?? x.duration ?? "?"})`).join(","));
        console.log("  metadata", JSON.stringify(st.metadata).slice(0, 600));
        const counts: Record<string, number> = {};
        for (const e of result.events as any[]) counts[e.type] = (counts[e.type] ?? 0) + 1;
        console.log("  last step events", counts);
        console.log("  replay tail:", JSON.stringify((session as any).getReplay?.()?.steps?.slice?.(-3) ?? "").slice(0, 1500));
      }
      totalSteps += steps;
      if (result.finished) finished++;
      else stalled.push(`${battleId}: ${ids.join(",")}`);
    } catch (err: any) {
      errors.push(`${battleId} [${ids.join(",")}]: ${err?.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
    }
  }
}

hits.sort((a, b) => b.ratio - a.ratio);
const never = roster.filter((c: any) => !appearances.has(c.id)).map((c: any) => c.id);
console.log(`battles ${MODES.length * battlesPerMode}, finished ${finished}, stalled ${stalled.length}, errors ${errors.length}, avg steps ${(totalSteps / Math.max(1, finished)).toFixed(1)}`);
console.log(`characters ${roster.length}, never drawn ${never.length}${never.length ? ": " + never.join(",") : ""}`);
for (const e of errors.slice(0, 15)) console.log("ERROR", e);
for (const s of stalled.slice(0, 10)) console.log("STALLED", s);
console.log("biggest hits (share of target max HP):");
for (const h of hits.slice(0, 12)) console.log(`  ${(h.ratio * 100).toFixed(0)}%  ${h.amount}  ${h.actor} ${h.skill} -> ${h.target} (${h.mode})`);
