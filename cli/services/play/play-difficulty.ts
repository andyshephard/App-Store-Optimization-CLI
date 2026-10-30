import { normalizeTextForKeywordMatch } from "../../shared/aso-keyword-utils";
import {
  RATING_DIFFICULTY_MAX,
  RATING_DIFFICULTY_MIN,
  RATING_DIFFICULTY_TOP_N,
  RATING_DIFFICULTY_WEIGHTS,
} from "../cache-api/services/aso-rating-difficulty";
import type { PlaySearchApp } from "./play-search-parser";

/**
 * Google Play keyword difficulty (5-100) from the top 10 results, in the
 * spirit of the App Store ratings-mode model (aso-rating-difficulty.ts):
 * score each top app's strength, sort strongest first, and weight the slots
 * with the same weights - how many strong apps there are matters more than
 * where they sit. Empty slots (fewer than 10 results) count as zero.
 *
 * Play's search list has no rating counts, so an app's strength is:
 * - reach: its install band on a log scale, 100 installs = 0 .. 100M+ = 1;
 * - quality: its star rating, 0.8 (unrated or <= 3.5) .. 1.0 (5.0);
 * - relevance: whether its title holds the keyword - an app ranking on the
 *   exact phrase in its title is a harder incumbent than one ranking on
 *   description text: 1.0 exact phrase, 0.85 every word, 0.7 otherwise.
 *
 * Not fitted to any reference yet (there is no Play equivalent of the Astro
 * scores the App Store model was fitted to); compare keywords against each
 * other, not against App Store difficulty.
 */
export const PLAY_DIFFICULTY_MODEL_VERSION = "play-installs-v1";

const REACH_LOG_FLOOR = 2;
const REACH_LOG_SPAN = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type PlayTitleMatch = "titleExactPhrase" | "titleAllWords" | "none";

export function detectPlayTitleMatch(title: string, keyword: string): PlayTitleMatch {
  const normKeyword = normalizeTextForKeywordMatch(keyword);
  const normTitle = normalizeTextForKeywordMatch(title);
  if (!normKeyword) return "none";
  if (` ${normTitle} `.includes(` ${normKeyword} `)) return "titleExactPhrase";
  const titleWords = new Set(normTitle.split(" ").filter(Boolean));
  const parts = normKeyword.split(" ").filter(Boolean);
  if (parts.length > 0 && parts.every((word) => titleWords.has(word))) {
    return "titleAllWords";
  }
  return "none";
}

export function playAppStrength(app: PlaySearchApp, keyword: string): number {
  const installs = app.installs != null && app.installs > 0 ? app.installs : 0;
  const reach = clamp((Math.log10(1 + installs) - REACH_LOG_FLOOR) / REACH_LOG_SPAN, 0, 1);
  const quality =
    app.rating == null ? 0.8 : 0.8 + 0.2 * clamp((app.rating - 3.5) / 1.5, 0, 1);
  const match = detectPlayTitleMatch(app.title, keyword);
  const relevance = match === "titleExactPhrase" ? 1 : match === "titleAllWords" ? 0.85 : 0.7;
  return reach * quality * relevance;
}

export function calculatePlayDifficulty(apps: PlaySearchApp[], keyword: string): number {
  const strengths = Array.from({ length: RATING_DIFFICULTY_TOP_N }, (_, index) =>
    apps[index] ? playAppStrength(apps[index], keyword) : 0
  ).sort((a, b) => b - a);
  const totalWeight = RATING_DIFFICULTY_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const weighted = strengths.reduce(
    (sum, strength, index) => sum + RATING_DIFFICULTY_WEIGHTS[index] * strength,
    0
  );
  const raw = RATING_DIFFICULTY_MIN + (RATING_DIFFICULTY_MAX - RATING_DIFFICULTY_MIN) * (weighted / totalWeight);
  return Math.round(clamp(raw, RATING_DIFFICULTY_MIN, RATING_DIFFICULTY_MAX));
}
