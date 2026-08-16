import { getDb } from "./store";
import { normalizeKeyword } from "../domain/keywords/policy";

export interface StoredKeywordPopularityHistoryPoint {
  country: string;
  normalizedKeyword: string;
  /** Start date (Sunday) of the weekly window, YYYY-MM-DD. */
  week: string;
  popularity: number;
  genre: string | null;
  rankInGenre: number | null;
}

export function upsertKeywordPopularityHistoryPoints(
  points: Array<{
    country: string;
    keyword: string;
    week: string;
    popularity: number;
    genre?: string | null;
    rankInGenre?: number | null;
  }>
): void {
  if (points.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO aso_keyword_popularity_history (
      country, normalized_keyword, week, popularity, genre, rank_in_genre
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(country, normalized_keyword, week) DO UPDATE SET
      popularity = excluded.popularity,
      genre = excluded.genre,
      rank_in_genre = excluded.rank_in_genre`
  );
  const tx = db.transaction(() => {
    for (const point of points) {
      const keyword = normalizeKeyword(point.keyword);
      if (!keyword || !point.week) continue;
      stmt.run(
        point.country,
        keyword,
        point.week,
        point.popularity,
        point.genre ?? null,
        point.rankInGenre ?? null
      );
    }
  });
  tx();
}

export function listKeywordPopularityHistory(
  country: string,
  keyword: string
): StoredKeywordPopularityHistoryPoint[] {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) return [];
  const db = getDb();
  return db
    .prepare(
      `SELECT
         country,
         normalized_keyword as normalizedKeyword,
         week,
         popularity,
         genre,
         rank_in_genre as rankInGenre
       FROM aso_keyword_popularity_history
       WHERE country = ? AND normalized_keyword = ?
       ORDER BY week ASC`
    )
    .all(country, normalized) as StoredKeywordPopularityHistoryPoint[];
}

/**
 * Latest two weekly points per keyword, for computing a popularity trend
 * without loading full histories. Returns a map keyed by normalized keyword.
 */
export function getLatestPopularityTrends(
  country: string,
  keywords: string[]
): Map<string, { latest: number; previous: number | null }> {
  const trends = new Map<string, { latest: number; previous: number | null }>();
  if (keywords.length === 0) return trends;
  const db = getDb();
  const stmt = db.prepare(
    `SELECT popularity
     FROM aso_keyword_popularity_history
     WHERE country = ? AND normalized_keyword = ?
     ORDER BY week DESC
     LIMIT 2`
  );
  for (const keyword of keywords) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) continue;
    const rows = stmt.all(country, normalized) as Array<{
      popularity: number;
    }>;
    if (rows.length === 0) continue;
    trends.set(normalized, {
      latest: rows[0].popularity,
      previous: rows[1]?.popularity ?? null,
    });
  }
  return trends;
}
