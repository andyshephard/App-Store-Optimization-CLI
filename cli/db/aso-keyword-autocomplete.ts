import { getDb } from "./store";

/**
 * App Store autocomplete evidence per keyword: the fewest letters of the
 * keyword a user must type before Apple suggests it, and its position in that
 * suggestion list. NULL letters = never suggested. A demand signal for terms
 * Apple's popularity endpoint reports at its floor of 5 (no data).
 */
export type KeywordAutocomplete = {
  country: string;
  keyword: string;
  lettersNeeded: number | null;
  hintRank: number | null;
  checkedAt: string;
};

export function upsertKeywordAutocomplete(rows: KeywordAutocomplete[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO aso_keyword_autocomplete (country, normalized_keyword, letters_needed, hint_rank, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(country, normalized_keyword) DO UPDATE SET
       letters_needed = excluded.letters_needed,
       hint_rank = excluded.hint_rank,
       checked_at = excluded.checked_at`
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.country, r.keyword, r.lettersNeeded, r.hintRank, r.checkedAt);
    }
  })();
}

export function listKeywordAutocomplete(country: string): KeywordAutocomplete[] {
  return getDb()
    .prepare(
      `SELECT country, normalized_keyword AS keyword, letters_needed AS lettersNeeded,
              hint_rank AS hintRank, checked_at AS checkedAt
       FROM aso_keyword_autocomplete WHERE country = ? ORDER BY normalized_keyword`
    )
    .all(country) as KeywordAutocomplete[];
}

/**
 * Tracked keywords (linked to any app) whose autocomplete check is missing or
 * older than the cut-off, oldest first.
 */
export function listKeywordsDueForAutocomplete(
  country: string,
  checkedBefore: string,
  limit: number
): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT ak.keyword
         FROM app_keywords ak
         LEFT JOIN aso_keyword_autocomplete a
           ON a.country = ak.country AND a.normalized_keyword = ak.keyword
         WHERE ak.country = ? AND (a.checked_at IS NULL OR a.checked_at < ?)
         ORDER BY a.checked_at IS NOT NULL, a.checked_at, ak.keyword
         LIMIT ?`
      )
      .all(country, checkedBefore, limit) as Array<{ keyword: string }>
  ).map((r) => r.keyword);
}
