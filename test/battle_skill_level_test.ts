import assert from "node:assert/strict";

import { applySkillLevelToEffect, getSkillLevelBonus, type BattleState } from "../src/modules/battle-core";
import { buildBattleState, createTestEngine, eventsOfType, makeEffect, makeSkill, startTurnOf, statusEffect } from "./helpers/battle-test-kit";

const levelBonuses = [
  { damagePct: 0, healPct: 0, effectChancePct: 0 },
  { damagePct: 10, healPct: 20, effectChancePct: 15 },
  { damagePct: 30, healPct: 40, effectChancePct: 50 },
];

function duel(level: number): BattleState {
  const strike = makeSkill("strike", [makeEffect({ damageTerms: [{ source: "Attack", multiplier: 2 }] })], { maxSkillLevel: 3, levelBonuses });
  return buildBattleState([
    { id: "A", side: "players", skills: [strike], skillLevels: { strike: level }, turnBar: 1000, stats: { cr: 0 } },
    { id: "E", side: "enemies", skills: [strike], stats: { hp: 100000 } },
  ]);
}

function damageOf(level: number): number {
  const engine = createTestEngine();
  const turn = startTurnOf(engine, duel(level), "A");
  const result = engine.dispatch(turn.state, { type: "use_skill", actorId: "A", skillId: "strike", targetId: "E" });
  return eventsOfType(result.events, "damage_applied").reduce((sum, event) => sum + event.amount, 0);
}

describe("Skill levels (skill-ups)", () => {
  it("returns cumulative bonuses clamped to the authored levels", () => {
    const skill = makeSkill("s", [], { maxSkillLevel: 3, levelBonuses });
    assert.deepEqual(getSkillLevelBonus(skill, 1), levelBonuses[0]);
    assert.deepEqual(getSkillLevelBonus(skill, 3), levelBonuses[2]);
    assert.deepEqual(getSkillLevelBonus(skill, 9), levelBonuses[2]);
    assert.deepEqual(getSkillLevelBonus(makeSkill("plain", []), 3), { damagePct: 0, healPct: 0, effectChancePct: 0 });
  });

  it("scales damage, heals and chances below 100% without mutating the skill", () => {
    const damage = makeEffect({ damageTerms: [{ source: "Attack", multiplier: 2 }], flatDamageBonus: 10 });
    const leveled = applySkillLevelToEffect(damage, levelBonuses[2]);
    assert.equal(leveled.damageTerms[0].multiplier, 2.6);
    assert.equal(leveled.flatDamageBonus, 13);
    assert.equal(damage.damageTerms[0].multiplier, 2, "shared effect untouched");

    const heal = applySkillLevelToEffect(makeEffect({ type: "Heal", damageTerms: [], healScale: 0.2, flatHealBonus: 50 }), levelBonuses[2]);
    assert.ok(Math.abs(heal.healScale - 0.28) < 1e-12);
    assert.equal(heal.flatHealBonus, 70);

    const debuff = applySkillLevelToEffect(statusEffect("Stun", 1, { applyChance: 0.3, baseChance: 0.8 }), levelBonuses[2]);
    assert.equal(debuff.applyChance, 0.8);
    assert.equal(debuff.baseChance, 1);
    assert.equal(applySkillLevelToEffect(statusEffect("Stun", 1, { applyChance: 1 }), levelBonuses[2]).applyChance, 1);

    const none = makeEffect();
    assert.equal(applySkillLevelToEffect(none, levelBonuses[0]), none);
  });

  it("hits harder at a higher unit skill level", () => {
    const base = damageOf(1);
    const maxed = damageOf(3);
    assert.ok(base > 0);
    assert.ok(maxed > base * 1.25 && maxed < base * 1.35, `level 3 = ${maxed}, level 1 = ${base}`);
  });
});
