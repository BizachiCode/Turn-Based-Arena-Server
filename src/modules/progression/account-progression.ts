// Account (summoner) level rules (pure). `expPerLevel[i]` is the EXP needed to go from level i + 1 to i + 2.

export type AccountExpCurve = { maxLevel: number; expPerLevel: number[] };

export type AccountExpResult = {
  level: number;
  exp: number;
  /** EXP actually consumed (0 at max level). */
  expGained: number;
  levelsGained: number;
  /** Every level reached by this grant, in order. */
  reachedLevels: number[];
};

/** EXP needed to leave `level` (0 = cannot level further). */
export function expToNextAccountLevel(curve: AccountExpCurve, level: number): number {
  if (level >= curve.maxLevel) return 0;
  const need = curve.expPerLevel[level - 1];
  return Number.isFinite(need) && need > 0 ? need : 0;
}

export function applyAccountExp(curve: AccountExpCurve, level: number, exp: number, gained: number): AccountExpResult {
  let currentLevel = Math.max(1, Math.floor(level) || 1);
  let currentExp = Math.max(0, Math.floor(exp) || 0);
  let remaining = Math.max(0, Math.floor(gained) || 0);
  let expGained = 0;
  const reachedLevels: number[] = [];

  while (remaining > 0) {
    const need = expToNextAccountLevel(curve, currentLevel);
    if (need <= 0) break; // max level (or no curve): extra EXP is discarded
    const step = Math.min(remaining, need - currentExp);
    currentExp += step;
    remaining -= step;
    expGained += step;
    if (currentExp >= need) {
      currentLevel++;
      currentExp = 0;
      reachedLevels.push(currentLevel);
    }
  }
  if (expToNextAccountLevel(curve, currentLevel) <= 0) currentExp = 0;

  return { level: currentLevel, exp: currentExp, expGained, levelsGained: reachedLevels.length, reachedLevels };
}
