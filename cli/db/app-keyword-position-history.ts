import type { StoredAppKeywordPositionHistoryPoint } from "./types";
import { getDb } from "./store";
import {
  DEFAULT_ASO_COUNTRY,
  normalizeKeyword,
} from "../domain/keywords/policy";

const COUNTRY = DEFAULT_ASO_COUNTRY;

type AppKeywordPositionHistoryRow = {
  appId: string;
  keyword: string;
  country: string;
  position: number | null;
  capturedAt: string;
};

function toStoredAppKeywordPositionHistoryPoint(
  row: AppKeywordPositionHistoryRow
): StoredAppKeywordPositionHistoryPoint {
  return {
    appId: row.appId,
    keyword: row.keyword,
    country: row.country,
    position: row.position,
    capturedAt: row.capturedAt,
  };
}

export function insertAppKeywordPositionHistoryPoints(
  points: Array<{
    appId: string;
    keyword: string;
    country?: string;
    position: number | null;
    capturedAt?: string;
  }>
): void {
  if (points.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO app_keyword_position_history (
      app_id, keyword, country, position, captured_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(app_id, keyword, country, captured_at) DO UPDATE SET
      position = excluded.position`
  );
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const point of points) {
      const appId = point.appId.trim();
      const keyword = normalizeKeyword(point.keyword);
      const country = point.country ?? COUNTRY;
      if (!appId || !keyword) continue;
      stmt.run(
        appId,
        keyword,
        country,
        point.position,
        point.capturedAt ?? now
      );
    }
  });
  tx();
}

export function listAppKeywordPositionHistory(
  appId: string,
  keyword: string,
  country: string = COUNTRY
): StoredAppKeywordPositionHistoryPoint[] {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!appId || !normalizedKeyword) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         app_id as appId,
         keyword,
         country,
         position,
         captured_at as capturedAt
       FROM app_keyword_position_history
       WHERE app_id = ? AND keyword = ? AND country = ? AND position IS NOT NULL
       ORDER BY captured_at ASC`
    )
    .all(appId, normalizedKeyword, country) as AppKeywordPositionHistoryRow[];
  return rows.map(toStoredAppKeywordPositionHistoryPoint);
}

export function pruneAppKeywordPositionHistoryBefore(cutoffIso: string): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM app_keyword_position_history
       WHERE captured_at < ?`
    )
    .run(cutoffIso);
  return result.changes;
}

export type DailyPositionPoint = {
  appId: string;
  keyword: string;
  country: string;
  date: string;
  position: number | null;
};

/** Position in the export order (date, app, keyword, country) to resume after. */
export type DailyPositionCursor = {
  date: string;
  appId: string;
  keyword: string;
  country: string;
};

export function encodeDailyPositionCursor(point: DailyPositionCursor): string {
  return Buffer.from(
    JSON.stringify([point.date, point.appId, point.keyword, point.country]),
    "utf8"
  ).toString("base64url");
}

export function decodeDailyPositionCursor(raw: string): DailyPositionCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((value) => typeof value === "string")
    ) {
      const [date, appId, keyword, country] = parsed as string[];
      return { date, appId, keyword, country };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * One point per app, keyword, country and UTC day — the day's last capture —
 * for exporting history (the middleware warehouse sync). Ordered for stable
 * pagination: `after` (keyset, rows strictly after that point) is preferred;
 * `offset` still works but rescans every skipped row.
 */
export function listDailyPositionHistory(params: {
  since: string;
  appIds?: string[];
  limit: number;
  offset: number;
  after?: DailyPositionCursor | null;
}): DailyPositionPoint[] {
  const db = getDb();
  const appFilter =
    params.appIds && params.appIds.length > 0
      ? `AND app_id IN (${params.appIds.map(() => "?").join(",")})`
      : "";
  return db
    .prepare(
      `SELECT app_id AS appId, keyword, country, day AS date, position
       FROM (
         SELECT app_id, keyword, country, position,
                substr(captured_at, 1, 10) AS day,
                ROW_NUMBER() OVER (
                  PARTITION BY app_id, keyword, country, substr(captured_at, 1, 10)
                  ORDER BY captured_at DESC
                ) AS rn
         FROM app_keyword_position_history
         WHERE captured_at >= ? ${appFilter}
       )
       WHERE rn = 1 ${params.after ? "AND (day, app_id, keyword, country) > (?, ?, ?, ?)" : ""}
       ORDER BY date, app_id, keyword, country
       LIMIT ? OFFSET ?`
    )
    .all(
      params.since,
      ...(params.appIds ?? []),
      ...(params.after
        ? [params.after.date, params.after.appId, params.after.keyword, params.after.country]
        : []),
      params.limit,
      params.after ? 0 : params.offset
    ) as DailyPositionPoint[];
}
