import { getDb } from "./store";
import { normalizeKeyword } from "../domain/keywords/policy";

/**
 * Google Play autocomplete suggestions (play_keyword_suggestions, schema v6).
 * The autocomplete check (play-keyword-service.ts) asks Play's suggestions
 * for the prefixes of our tracked keywords; every answer is kept here, so the
 * terms Play suggests can be offered as new keyword ideas without another
 * request. Rows are per country, prefix and suggestion and hold the prefix's
 * latest answer: a suggestion that drops out of a prefix's list is removed
 * when that prefix is asked again.
 */

/** Rows not seen for this long are pruned by the nightly refresh. */
export const PLAY_SUGGESTIONS_RETENTION_DAYS = 90;
/** The default and largest window of GET /api/aso/play-suggestions. */
export const PLAY_SUGGESTIONS_DEFAULT_DAYS = 14;
export const PLAY_SUGGESTIONS_MAX_DAYS = 90;

export type PlaySuggestion = {
  /** The suggested term, normalized (trimmed, lower-case). */
  keyword: string;
  country: string;
  /** The shortest prefix that suggested it. */
  prefix: string;
  /** Characters of that prefix: the fewest typed before Play suggested the term. */
  letters: number;
  /** Its position (1-5) in that prefix's list. */
  position: number;
  /** The tracked keyword whose autocomplete check asked that prefix. */
  seed: string;
  /** How many of the asked prefixes suggested it. */
  prefixCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Whether the term is itself tracked in this country (only with includeTracked). */
  tracked: boolean;
};

/**
 * Stores one prefix's answer: each suggestion with its position, the seed and
 * when it was seen (first_seen_at is kept for one already there), and drops
 * the prefix's earlier suggestions that are no longer in the list. An empty
 * list clears the prefix. Returns how many suggestions were stored.
 */
export function recordPlaySuggestions(params: {
  country: string;
  prefix: string;
  seed: string;
  suggestions: string[];
  seenAt: string;
}): number {
  const db = getDb();
  const country = params.country.toUpperCase();
  const prefix = params.prefix.toLowerCase();
  const seed = normalizeKeyword(params.seed);
  const terms: string[] = [];
  for (const raw of params.suggestions) {
    const term = normalizeKeyword(String(raw ?? ""));
    if (term && !terms.includes(term)) terms.push(term);
  }
  db.transaction(() => {
    const placeholders = terms.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM play_keyword_suggestions WHERE country = ? AND prefix = ?
       ${terms.length ? `AND suggestion NOT IN (${placeholders})` : ""}`
    ).run(country, prefix, ...terms);
    const upsert = db.prepare(
      `INSERT INTO play_keyword_suggestions (country, prefix, suggestion, position, seed, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(country, prefix, suggestion) DO UPDATE SET
         position = excluded.position,
         seed = excluded.seed,
         last_seen_at = excluded.last_seen_at`
    );
    terms.forEach((term, index) => {
      upsert.run(country, prefix, term, index + 1, seed, params.seenAt, params.seenAt);
    });
  })();
  return terms.length;
}

type RawSuggestion = {
  keyword: string;
  country: string;
  prefix: string;
  letters: number;
  position: number;
  seed: string;
  prefixCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  tracked: number;
};

/**
 * One row per suggested term seen since `since` in a country: its shortest
 * prefix (then best position) with that prefix's seed, how many prefixes
 * suggested it, and when it was first and last seen. Terms tracked on Play in
 * that country (any app) are left out unless `includeTracked`. Ordered by
 * letters, then position, then term.
 */
export function listPlaySuggestions(params: {
  country: string;
  since: string;
  includeTracked?: boolean;
}): PlaySuggestion[] {
  const rows = getDb()
    .prepare(
      `WITH recent AS (
         SELECT * FROM play_keyword_suggestions WHERE country = ? AND last_seen_at >= ?
       ),
       ranked AS (
         SELECT suggestion, prefix, position, seed,
                ROW_NUMBER() OVER (
                  PARTITION BY suggestion
                  ORDER BY length(prefix), position, last_seen_at DESC, prefix
                ) AS rn
         FROM recent
       ),
       agg AS (
         SELECT suggestion, COUNT(*) AS prefix_count, MIN(first_seen_at) AS first_seen_at,
                MAX(last_seen_at) AS last_seen_at
         FROM recent GROUP BY suggestion
       )
       SELECT r.suggestion AS keyword, ? AS country, r.prefix AS prefix, length(r.prefix) AS letters,
              r.position AS position, r.seed AS seed, a.prefix_count AS prefixCount,
              a.first_seen_at AS firstSeenAt, a.last_seen_at AS lastSeenAt,
              EXISTS (
                SELECT 1 FROM play_app_keywords ak WHERE ak.country = ? AND ak.keyword = r.suggestion
              ) AS tracked
       FROM ranked r JOIN agg a USING (suggestion)
       WHERE r.rn = 1
       ORDER BY letters, position, keyword`
    )
    .all(params.country, params.since, params.country, params.country) as RawSuggestion[];
  return rows
    .map((row) => ({ ...row, tracked: row.tracked === 1 }))
    .filter((row) => params.includeTracked || !row.tracked);
}

/** Drops suggestions not seen since `before`. */
export function prunePlaySuggestions(before: string): number {
  return getDb()
    .prepare(`DELETE FROM play_keyword_suggestions WHERE last_seen_at < ?`)
    .run(before).changes;
}
