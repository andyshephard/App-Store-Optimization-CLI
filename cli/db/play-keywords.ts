import { getDb } from "./store";
import { normalizeKeyword } from "../domain/keywords/policy";

/**
 * Google Play keyword tracking. Mirrors the App Store tables (app_keywords,
 * aso_keywords, aso_keyword_autocomplete, aso_keyword_failures,
 * app_keyword_position_history) in separate play_* tables, so nothing here
 * can change an App Store row. App ids are package names.
 */

export type PlayTopApp = {
  appId: string;
  title: string;
  developer: string | null;
  category: string | null;
  installs: number | null;
  installsBand: string | null;
  rating: number | null;
  ratingCount: number | null;
  isTopCard: boolean;
};

export type PlayKeywordObservation = {
  country: string;
  keyword: string;
  difficultyScore: number;
  difficultyModelVersion: string;
  /** Results Play listed (<= 30). */
  resultCount: number;
  /**
   * How deep the ranking was checked: the result count, which is the whole
   * list - Play shows at most 30 results, so "not ranked" means not in the
   * top `rankDepth`.
   */
  rankDepth: number;
  layout: string;
  orderedAppIds: string[];
  topApps: PlayTopApp[];
  observedAt: string;
};

export type StoredPlayKeyword = PlayKeywordObservation & {
  normalizedKeyword: string;
  createdAt: string;
};

export type PlayAppKeyword = {
  appId: string;
  keyword: string;
  country: string;
  isFavorite: boolean;
  previousPosition: number | null;
  addedAt: string | null;
};

export type PlayKeywordAutocomplete = {
  country: string;
  keyword: string;
  lettersNeeded: number | null;
  hintRank: number | null;
  checkedAt: string;
};

export type PlayKeywordFailure = {
  country: string;
  keyword: string;
  stage: "search" | "autocomplete";
  reasonCode: string;
  message: string;
  statusCode: number | null;
  attempts: number;
  updatedAt: string;
};

export type PlayDailyPositionPoint = {
  appId: string;
  keyword: string;
  country: string;
  date: string;
  position: number | null;
};

/** Days of play_keyword_position_history kept, as for the App Store. */
export const PLAY_POSITION_HISTORY_RETENTION_DAYS = 730;

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Adds associations; returns how many were new. */
export function addPlayAppKeywords(appId: string, keywords: string[], country: string): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO play_app_keywords (app_id, keyword, country, is_favorite, previous_position, added_at)
     VALUES (?, ?, ?, 0, NULL, ?)`
  );
  const now = new Date().toISOString();
  let added = 0;
  db.transaction(() => {
    for (const keyword of keywords) {
      const normalized = normalizeKeyword(keyword);
      if (!normalized) continue;
      added += stmt.run(appId, normalized, country, now).changes;
    }
  })();
  return added;
}

/** Removes associations; returns how many existed. Observations are kept. */
export function removePlayAppKeywords(appId: string, keywords: string[], country: string): number {
  const db = getDb();
  const stmt = db.prepare(
    `DELETE FROM play_app_keywords WHERE app_id = ? AND keyword = ? AND country = ?`
  );
  let removed = 0;
  db.transaction(() => {
    for (const keyword of keywords) {
      removed += stmt.run(appId, normalizeKeyword(keyword), country).changes;
    }
  })();
  return removed;
}

export function listPlayAppKeywords(params: { country?: string; appId?: string } = {}): PlayAppKeyword[] {
  const where: string[] = [];
  const args: string[] = [];
  if (params.country) {
    where.push("country = ?");
    args.push(params.country);
  }
  if (params.appId) {
    where.push("app_id = ?");
    args.push(params.appId);
  }
  const rows = getDb()
    .prepare(
      `SELECT app_id AS appId, keyword, country, is_favorite AS isFavorite,
              previous_position AS previousPosition, added_at AS addedAt
       FROM play_app_keywords
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY country, app_id, keyword`
    )
    .all(...args) as Array<Omit<PlayAppKeyword, "isFavorite"> & { isFavorite: number }>;
  return rows.map((row) => ({ ...row, isFavorite: row.isFavorite === 1 }));
}

/** Countries with at least one tracked Play keyword. */
export function listPlayTrackedCountries(): string[] {
  return (
    getDb()
      .prepare(`SELECT DISTINCT country FROM play_app_keywords ORDER BY country`)
      .all() as Array<{ country: string }>
  ).map((row) => row.country);
}

/**
 * Tracked keywords in a country, least recently crawled first (never-crawled
 * first of all), so a run that stops early resumes where it left off.
 */
export function listPlayKeywordsForRefresh(country: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT ak.keyword AS keyword, k.updated_at AS updatedAt
         FROM play_app_keywords ak
         LEFT JOIN play_keywords k
           ON k.country = ak.country AND k.normalized_keyword = ak.keyword
         WHERE ak.country = ?
         ORDER BY k.updated_at IS NOT NULL, k.updated_at, ak.keyword`
      )
      .all(country) as Array<{ keyword: string }>
  ).map((row) => row.keyword);
}

type RawPlayKeyword = {
  country: string;
  normalized_keyword: string;
  keyword: string;
  difficulty_score: number | null;
  difficulty_model_version: string | null;
  result_count: number;
  rank_depth: number;
  layout: string;
  ordered_app_ids: string;
  top_apps_json: string | null;
  created_at: string;
  updated_at: string;
};

function toStoredPlayKeyword(row: RawPlayKeyword): StoredPlayKeyword {
  return {
    country: row.country,
    normalizedKeyword: row.normalized_keyword,
    keyword: row.keyword,
    difficultyScore: row.difficulty_score ?? 0,
    difficultyModelVersion: row.difficulty_model_version ?? "",
    resultCount: row.result_count,
    rankDepth: row.rank_depth,
    layout: row.layout,
    orderedAppIds: parseJsonArray<string>(row.ordered_app_ids),
    topApps: parseJsonArray<PlayTopApp>(row.top_apps_json),
    observedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function getPlayKeyword(country: string, keyword: string): StoredPlayKeyword | null {
  const row = getDb()
    .prepare(`SELECT * FROM play_keywords WHERE country = ? AND normalized_keyword = ?`)
    .get(country, normalizeKeyword(keyword)) as RawPlayKeyword | undefined;
  return row ? toStoredPlayKeyword(row) : null;
}

export function listPlayKeywords(country: string, keywords: string[]): StoredPlayKeyword[] {
  if (keywords.length === 0) return [];
  const placeholders = keywords.map(() => "?").join(", ");
  return (
    getDb()
      .prepare(
        `SELECT * FROM play_keywords WHERE country = ? AND normalized_keyword IN (${placeholders})`
      )
      .all(country, ...keywords.map(normalizeKeyword)) as RawPlayKeyword[]
  ).map(toStoredPlayKeyword);
}

function positionOf(orderedAppIds: string[], appId: string): number | null {
  const index = orderedAppIds.indexOf(appId);
  return index >= 0 ? index + 1 : null;
}

/**
 * Stores one successful crawl: the latest observation, each tracked app's
 * previous position (the position before this crawl), a position-history
 * point for every tracked app and roster app, and clears the search failure.
 * One transaction.
 */
export function savePlayKeywordObservation(
  observation: PlayKeywordObservation,
  options: { rosterAppIds?: string[] } = {}
): void {
  const db = getDb();
  const normalized = normalizeKeyword(observation.keyword);
  const country = observation.country;
  db.transaction(() => {
    const previous = db
      .prepare(
        `SELECT ordered_app_ids FROM play_keywords WHERE country = ? AND normalized_keyword = ?`
      )
      .get(country, normalized) as { ordered_app_ids: string } | undefined;
    db.prepare(
      `INSERT INTO play_keywords (
         country, normalized_keyword, keyword, difficulty_score, difficulty_model_version,
         result_count, rank_depth, layout, ordered_app_ids, top_apps_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(country, normalized_keyword) DO UPDATE SET
         keyword = excluded.keyword,
         difficulty_score = excluded.difficulty_score,
         difficulty_model_version = excluded.difficulty_model_version,
         result_count = excluded.result_count,
         rank_depth = excluded.rank_depth,
         layout = excluded.layout,
         ordered_app_ids = excluded.ordered_app_ids,
         top_apps_json = excluded.top_apps_json,
         updated_at = excluded.updated_at`
    ).run(
      country,
      normalized,
      observation.keyword,
      observation.difficultyScore,
      observation.difficultyModelVersion,
      observation.resultCount,
      observation.rankDepth,
      observation.layout,
      JSON.stringify(observation.orderedAppIds),
      JSON.stringify(observation.topApps),
      observation.observedAt,
      observation.observedAt
    );

    const trackedAppIds = (
      db
        .prepare(`SELECT app_id FROM play_app_keywords WHERE country = ? AND keyword = ?`)
        .all(country, normalized) as Array<{ app_id: string }>
    ).map((row) => row.app_id);
    if (previous) {
      const previousOrder = parseJsonArray<string>(previous.ordered_app_ids);
      const setPrevious = db.prepare(
        `UPDATE play_app_keywords SET previous_position = ?
         WHERE app_id = ? AND keyword = ? AND country = ?`
      );
      for (const appId of trackedAppIds) {
        setPrevious.run(positionOf(previousOrder, appId), appId, normalized, country);
      }
    }

    const insertHistory = db.prepare(
      `INSERT OR REPLACE INTO play_keyword_position_history (app_id, keyword, country, position, captured_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const historyAppIds = new Set([...trackedAppIds, ...(options.rosterAppIds ?? [])]);
    for (const appId of historyAppIds) {
      const position = positionOf(observation.orderedAppIds, appId);
      // Roster apps only get a point where they rank; tracked apps always do,
      // so "fell out of the top 30" is recorded as a null.
      if (position == null && !trackedAppIds.includes(appId)) continue;
      insertHistory.run(appId, normalized, country, position, observation.observedAt);
    }

    db.prepare(
      `DELETE FROM play_keyword_failures WHERE country = ? AND normalized_keyword = ? AND stage = 'search'`
    ).run(country, normalized);
  })();
}

export function recordPlayKeywordFailure(params: {
  country: string;
  keyword: string;
  stage: "search" | "autocomplete";
  reasonCode: string;
  message: string;
  statusCode?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO play_keyword_failures (
         country, normalized_keyword, stage, reason_code, message, status_code, attempts, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(country, normalized_keyword, stage) DO UPDATE SET
         reason_code = excluded.reason_code,
         message = excluded.message,
         status_code = excluded.status_code,
         attempts = play_keyword_failures.attempts + 1,
         updated_at = excluded.updated_at`
    )
    .run(
      params.country,
      normalizeKeyword(params.keyword),
      params.stage,
      params.reasonCode,
      params.message.slice(0, 500),
      params.statusCode ?? null,
      new Date().toISOString()
    );
}

export function listPlayKeywordFailures(country: string): PlayKeywordFailure[] {
  return getDb()
    .prepare(
      `SELECT country, normalized_keyword AS keyword, stage, reason_code AS reasonCode, message,
              status_code AS statusCode, attempts, updated_at AS updatedAt
       FROM play_keyword_failures WHERE country = ? ORDER BY normalized_keyword, stage`
    )
    .all(country) as PlayKeywordFailure[];
}

export function upsertPlayKeywordAutocomplete(row: PlayKeywordAutocomplete): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO play_keyword_autocomplete (country, normalized_keyword, letters_needed, hint_rank, checked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(country, normalized_keyword) DO UPDATE SET
         letters_needed = excluded.letters_needed,
         hint_rank = excluded.hint_rank,
         checked_at = excluded.checked_at`
    ).run(row.country, normalizeKeyword(row.keyword), row.lettersNeeded, row.hintRank, row.checkedAt);
    db.prepare(
      `DELETE FROM play_keyword_failures WHERE country = ? AND normalized_keyword = ? AND stage = 'autocomplete'`
    ).run(row.country, normalizeKeyword(row.keyword));
  })();
}

export function listPlayKeywordAutocomplete(country: string): PlayKeywordAutocomplete[] {
  return getDb()
    .prepare(
      `SELECT country, normalized_keyword AS keyword, letters_needed AS lettersNeeded,
              hint_rank AS hintRank, checked_at AS checkedAt
       FROM play_keyword_autocomplete WHERE country = ? ORDER BY normalized_keyword`
    )
    .all(country) as PlayKeywordAutocomplete[];
}

/** Tracked keywords whose autocomplete check is missing or older than the cut-off, oldest first. */
export function listPlayKeywordsDueForAutocomplete(
  country: string,
  checkedBefore: string,
  limit: number
): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT ak.keyword
         FROM play_app_keywords ak
         LEFT JOIN play_keyword_autocomplete a
           ON a.country = ak.country AND a.normalized_keyword = ak.keyword
         WHERE ak.country = ? AND (a.checked_at IS NULL OR a.checked_at < ?)
         ORDER BY a.checked_at IS NOT NULL, a.checked_at, ak.keyword
         LIMIT ?`
      )
      .all(country, checkedBefore, limit) as Array<{ keyword: string }>
  ).map((row) => row.keyword);
}

export function countTrackedPlayKeywords(country: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(DISTINCT keyword) AS n FROM play_app_keywords WHERE country = ?`)
    .get(country) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** One point per app/keyword/country/day (the day's last), as listDailyPositionHistory. */
export function listPlayDailyPositionHistory(params: {
  since: string;
  appIds?: string[];
  limit: number;
  offset: number;
}): PlayDailyPositionPoint[] {
  const appIds = params.appIds ?? [];
  const appFilter = appIds.length ? `AND app_id IN (${appIds.map(() => "?").join(",")})` : "";
  return getDb()
    .prepare(
      `SELECT app_id AS appId, keyword, country, day AS date, position
       FROM (
         SELECT app_id, keyword, country, position,
                substr(captured_at, 1, 10) AS day,
                ROW_NUMBER() OVER (
                  PARTITION BY app_id, keyword, country, substr(captured_at, 1, 10)
                  ORDER BY captured_at DESC
                ) AS rn
         FROM play_keyword_position_history
         WHERE captured_at >= ? ${appFilter}
       )
       WHERE rn = 1
       ORDER BY date, app_id, keyword, country
       LIMIT ? OFFSET ?`
    )
    .all(params.since, ...appIds, params.limit, params.offset) as PlayDailyPositionPoint[];
}

export function prunePlayPositionHistory(before: string): number {
  return getDb()
    .prepare(`DELETE FROM play_keyword_position_history WHERE captured_at < ?`)
    .run(before).changes;
}

export type PlayKeywordListRow = {
  keyword: string;
  normalizedKeyword: string;
  country: string;
  appId: string;
  isFavorite: boolean;
  addedAt: string | null;
  previousPosition: number | null;
  observation: StoredPlayKeyword | null;
  autocomplete: PlayKeywordAutocomplete | null;
  failures: PlayKeywordFailure[];
};

/** Every tracked keyword of one app in one country, joined with its latest data. */
export function listPlayKeywordRowsForApp(appId: string, country: string): PlayKeywordListRow[] {
  const associations = listPlayAppKeywords({ appId, country });
  const keywords = associations.map((row) => row.keyword);
  const observations = new Map(
    listPlayKeywords(country, keywords).map((row) => [row.normalizedKeyword, row])
  );
  const autocomplete = new Map(
    listPlayKeywordAutocomplete(country).map((row) => [row.keyword, row])
  );
  const failures = new Map<string, PlayKeywordFailure[]>();
  for (const failure of listPlayKeywordFailures(country)) {
    const list = failures.get(failure.keyword) ?? [];
    list.push(failure);
    failures.set(failure.keyword, list);
  }
  return associations.map((association) => {
    const observation = observations.get(association.keyword) ?? null;
    return {
      keyword: observation?.keyword ?? association.keyword,
      normalizedKeyword: association.keyword,
      country,
      appId,
      isFavorite: association.isFavorite,
      addedAt: association.addedAt,
      previousPosition: association.previousPosition,
      observation,
      autocomplete: autocomplete.get(association.keyword) ?? null,
      failures: failures.get(association.keyword) ?? [],
    };
  });
}
