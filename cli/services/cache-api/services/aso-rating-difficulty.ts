/**
 * Keyword difficulty from the rating counts of the top search results.
 *
 * Modelled on Astro (tryastro.app), used as the reference implementation with
 * the developer's consent. Fitted against Astro's own scores for the same
 * keywords, taken from the same search results at the same moment. See
 * docs/aso-difficulty-model.md for the data, the fit and its error.
 *
 * Unlike the per-app competitive score in aso-difficulty.ts, this needs only
 * the ordered result ids and each top app's rating count, both available from
 * MZSearch + one batched iTunes lookup. No app page or localized page fetches.
 */

export const RATING_DIFFICULTY_TOP_N = 10;

/** log10(1 + ratingCount) is clamped into this range before weighting. */
const LOG_RATING_FLOOR = 1;
const LOG_RATING_CEILING = 6;

/**
 * Weight per slot after sorting the top apps strongest → weakest by rating
 * count. Position in the results matters less than how many strong apps
 * there are.
 */
export const RATING_DIFFICULTY_WEIGHTS = [
  2.525, 2.531, 3.034, 2.03, 1.559, 1.618, 1.23, 1.156, 1.294, 1.656,
] as const;
export const RATING_DIFFICULTY_RESULT_COUNT_WEIGHT = 0.0244;
export const RATING_DIFFICULTY_INTERCEPT = -23.402;

export const RATING_DIFFICULTY_MIN = 5;
export const RATING_DIFFICULTY_MAX = 100;

export type RatingDifficultyInputs = {
  /** Rating counts of the top results, in search order. Missing apps count as 0. */
  topRatingCounts: number[];
  /** Total number of search results for the keyword. */
  resultCount: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function calculateRatingDifficulty(input: RatingDifficultyInputs): number {
  const slots = Array.from({ length: RATING_DIFFICULTY_TOP_N }, (_, index) => {
    const count = input.topRatingCounts[index];
    const safe = Number.isFinite(count) && count > 0 ? count : 0;
    return clamp(Math.log10(1 + safe), LOG_RATING_FLOOR, LOG_RATING_CEILING);
  }).sort((a, b) => b - a);

  const resultCount = Number.isFinite(input.resultCount)
    ? Math.max(0, input.resultCount)
    : 0;

  let raw = RATING_DIFFICULTY_INTERCEPT;
  slots.forEach((value, index) => {
    raw += RATING_DIFFICULTY_WEIGHTS[index] * value;
  });
  raw += RATING_DIFFICULTY_RESULT_COUNT_WEIGHT * resultCount;

  return Math.round(clamp(raw, RATING_DIFFICULTY_MIN, RATING_DIFFICULTY_MAX));
}
