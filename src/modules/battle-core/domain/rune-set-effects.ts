export type BattleRuneSetEffects = {
  startOfBattleImmunityTurns: number;
  extraTurnChance: number;
  stunOnHitChance: number;
  counterattackChance: number;
  lifestealPercent: number;
  atbGainPerHpLostPercent: number;
  destroyMaxHpPercentPerHit: number;
};

export function createEmptyBattleRuneSetEffects(): BattleRuneSetEffects {
  return {
    startOfBattleImmunityTurns: 0,
    extraTurnChance: 0,
    stunOnHitChance: 0,
    counterattackChance: 0,
    lifestealPercent: 0,
    atbGainPerHpLostPercent: 0,
    destroyMaxHpPercentPerHit: 0,
  };
}

function readNonNegativeNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

export function readBattleRuneSetEffects(raw: unknown): BattleRuneSetEffects {
  if (!raw || typeof raw !== "object") {
    return createEmptyBattleRuneSetEffects();
  }

  const source = raw as Record<string, unknown>;
  return {
    startOfBattleImmunityTurns: Math.max(0, Math.round(readNonNegativeNumber(source.startOfBattleImmunityTurns))),
    extraTurnChance: readNonNegativeNumber(source.extraTurnChance),
    stunOnHitChance: readNonNegativeNumber(source.stunOnHitChance),
    counterattackChance: readNonNegativeNumber(source.counterattackChance),
    lifestealPercent: readNonNegativeNumber(source.lifestealPercent),
    atbGainPerHpLostPercent: readNonNegativeNumber(source.atbGainPerHpLostPercent),
    destroyMaxHpPercentPerHit: readNonNegativeNumber(source.destroyMaxHpPercentPerHit),
  };
}

export function mergeBattleRuneSetEffects(
  ...entries: Array<BattleRuneSetEffects | null | undefined>
): BattleRuneSetEffects {
  const out = createEmptyBattleRuneSetEffects();

  for (const entry of entries) {
    if (!entry) continue;
    out.startOfBattleImmunityTurns += Math.max(0, Math.round(Number(entry.startOfBattleImmunityTurns ?? 0)));
    out.extraTurnChance += readNonNegativeNumber(entry.extraTurnChance);
    out.stunOnHitChance += readNonNegativeNumber(entry.stunOnHitChance);
    out.counterattackChance += readNonNegativeNumber(entry.counterattackChance);
    out.lifestealPercent += readNonNegativeNumber(entry.lifestealPercent);
    out.atbGainPerHpLostPercent += readNonNegativeNumber(entry.atbGainPerHpLostPercent);
    out.destroyMaxHpPercentPerHit += readNonNegativeNumber(entry.destroyMaxHpPercentPerHit);
  }

  return out;
}
