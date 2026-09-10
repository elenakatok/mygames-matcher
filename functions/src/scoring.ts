// mygames-matcher / functions / scoring.ts
//
// The cross-team z-score, as a pure function — so its DIRECTION can be checked without a
// Firestore, a guest game, or a class.
//
// D11 — "Score direction is tenant configuration, not code. Lower-cost-is-better is
// hardcoded in scoreAndRecord. Kyle's games will not all be cost-minimizing, and the failure
// mode is a whole class graded backwards with nothing on any screen to indicate it."
//
// The direction comes from the tenant (tenants.ts scoreDirection). This module only knows
// how to apply it. `teamCost` keeps its contract name even for a points game: it is the
// guest's one numeric team outcome, and the direction says which way is better.

export type ScoreDirection = "lower_is_better" | "higher_is_better";

export interface CohortScore {
  mean: number;
  std: number;
  /** z for one team's outcome: POSITIVE for a better-than-average team, whichever way better points. */
  zFor: (teamOutcome: number) => number;
}

/**
 * Population mean/std over one outcome per team. std 0 (every team equal) → every z is 0.
 * Rounded to 4 dp, exactly as scoreAndRecord always has.
 */
export function cohortScore(teamOutcomes: number[], direction: ScoreDirection): CohortScore {
  if (direction !== "lower_is_better" && direction !== "higher_is_better") {
    // A typo'd tenant must not grade silently in either direction.
    throw new Error(`unknown scoreDirection ${JSON.stringify(direction)}`);
  }
  const n = teamOutcomes.length;
  const mean = n ? teamOutcomes.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? teamOutcomes.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  const std = Math.sqrt(variance);
  const sign = direction === "lower_is_better" ? -1 : 1;
  const zFor = (v: number): number => (std > 0 ? Number(((sign * (v - mean)) / std).toFixed(4)) + 0 : 0);
  return { mean, std, zFor };
}
