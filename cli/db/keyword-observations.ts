import { getDb } from "./store";

/**
 * Append-only feed of what was observed from Apple, one row per metric.
 *
 * Rows are never updated. The id is the cursor: a consumer reads
 * `id > since_cursor` in order and stores the last id it saw, so it gets each
 * observation exactly once even while new ones are being written.
 */

export type KeywordObservationMetric =
  | "rank"
  | "popularity"
  | "difficulty"
  | "app_count";

export type KeywordObservationInput = {
  keyword: string;
  country: string;
  metric: KeywordObservationMetric;
  value: number | null;
  /** e.g. asocli/mzsearch+searchpage, asa-legacy, asa-insights-monthly */
  source: string;
  /** When Apple was actually asked, not when the row was written. */
  sourceObservedAt: string;
  runId?: number | null;
  appId?: string | null;
  rank?: number | null;
  /** Rank rows only: false when the app was not in the crawled order. */
  ranked?: boolean | null;
  /** Rank rows only: how many positions the crawl covered. */
  rankDepth?: number | null;
  popularityIsFloor?: boolean | null;
  difficultyModelVersion?: string | null;
  appCount?: number | null;
  storefrontLanguage?: string | null;
};

export type KeywordObservation = KeywordObservationInput & {
  id: number;
  recordedAt: string;
};

type RawRow = {
  id: number;
  recorded_at: string;
  source_observed_at: string;
  country: string;
  keyword: string;
  metric: string;
  value: number | null;
  source: string;
  run_id: number | null;
  app_id: string | null;
  rank: number | null;
  ranked: number | null;
  rank_depth: number | null;
  popularity_is_floor: number | null;
  difficulty_model_version: string | null;
  app_count: number | null;
  storefront_language: string | null;
};

const toBool = (value: number | null): boolean | null =>
  value == null ? null : value === 1;
const fromBool = (value: boolean | null | undefined): number | null =>
  value == null ? null : value ? 1 : 0;

export function insertKeywordObservations(
  rows: KeywordObservationInput[],
  recordedAt: string = new Date().toISOString()
): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO keyword_observations (
       recorded_at, source_observed_at, country, keyword, metric, value, source,
       run_id, app_id, rank, ranked, rank_depth, popularity_is_floor,
       difficulty_model_version, app_count, storefront_language
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const row of rows) {
      statement.run(
        recordedAt,
        row.sourceObservedAt,
        row.country.toUpperCase(),
        row.keyword,
        row.metric,
        row.value,
        row.source,
        row.runId ?? null,
        row.appId ?? null,
        row.rank ?? null,
        fromBool(row.ranked),
        row.rankDepth ?? null,
        fromBool(row.popularityIsFloor),
        row.difficultyModelVersion ?? null,
        row.appCount ?? null,
        row.storefrontLanguage ?? null
      );
    }
  })();
  return rows.length;
}

export function listKeywordObservations(params: {
  sinceCursor: number;
  limit: number;
}): { items: KeywordObservation[]; nextCursor: number; hasMore: boolean } {
  const limit = Math.max(1, Math.floor(params.limit));
  const rows = getDb()
    .prepare(
      `SELECT * FROM keyword_observations WHERE id > ? ORDER BY id ASC LIMIT ?`
    )
    .all(Math.max(0, Math.floor(params.sinceCursor)), limit + 1) as RawRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(
    (row): KeywordObservation => ({
      id: row.id,
      recordedAt: row.recorded_at,
      sourceObservedAt: row.source_observed_at,
      country: row.country,
      keyword: row.keyword,
      metric: row.metric as KeywordObservationMetric,
      value: row.value,
      source: row.source,
      runId: row.run_id,
      appId: row.app_id,
      rank: row.rank,
      ranked: toBool(row.ranked),
      rankDepth: row.rank_depth,
      popularityIsFloor: toBool(row.popularity_is_floor),
      difficultyModelVersion: row.difficulty_model_version,
      appCount: row.app_count,
      storefrontLanguage: row.storefront_language,
    })
  );
  return {
    items,
    nextCursor: items.length > 0 ? items[items.length - 1].id : params.sinceCursor,
    hasMore,
  };
}

export function pruneKeywordObservationsBefore(cutoffIso: string): number {
  return getDb()
    .prepare(`DELETE FROM keyword_observations WHERE source_observed_at < ?`)
    .run(cutoffIso).changes;
}
