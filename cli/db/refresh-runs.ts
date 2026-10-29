import { getDb } from "./store";

/**
 * Persisted history of background refresh runs.
 *
 * The in-memory refresh state is lost on every restart, which made "did the
 * nightly refresh finish?" unanswerable, and a run killed mid-crawl (OOM,
 * deploy, host reboot) left no trace at all. A row is written when a run
 * starts and stamped when it finishes; a row still unfinished at the next
 * startup is marked `interrupted`.
 */

export type RefreshRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type RefreshRunRow = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: RefreshRunStatus;
  trigger: string;
  counters: Record<string, unknown> | null;
  lastError: string | null;
};

export type RefreshRunStorefrontRow = {
  runId: number;
  country: string;
  eligible: number;
  refreshed: number;
  failed: number;
  skipped: number;
  popularityFailed: number;
  abandoned: boolean;
  failureReasons: Record<string, number>;
  startedAt: string | null;
  finishedAt: string | null;
};

type RawRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  trigger: string;
  counters_json: string | null;
  last_error: string | null;
};

type RawStorefrontRow = {
  run_id: number;
  country: string;
  eligible: number;
  refreshed: number;
  failed: number;
  skipped: number;
  popularity_failed: number;
  abandoned: number;
  failure_reasons_json: string | null;
  started_at: string | null;
  finished_at: string | null;
};

function parseJsonObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function toRunRow(row: RawRunRow): RefreshRunRow {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as RefreshRunStatus,
    trigger: row.trigger,
    counters: parseJsonObject<Record<string, unknown>>(row.counters_json),
    lastError: row.last_error,
  };
}

function toStorefrontRow(row: RawStorefrontRow): RefreshRunStorefrontRow {
  return {
    runId: row.run_id,
    country: row.country,
    eligible: row.eligible,
    refreshed: row.refreshed,
    failed: row.failed,
    skipped: row.skipped,
    popularityFailed: row.popularity_failed,
    abandoned: row.abandoned === 1,
    failureReasons:
      parseJsonObject<Record<string, number>>(row.failure_reasons_json) ?? {},
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function insertRefreshRun(params: {
  trigger: string;
  startedAt: string;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO refresh_runs (started_at, status, trigger)
       VALUES (?, 'running', ?)`
    )
    .run(params.startedAt, params.trigger);
  return Number(result.lastInsertRowid);
}

export function upsertRefreshRunStorefront(
  runId: number,
  row: Omit<RefreshRunStorefrontRow, "runId">
): void {
  getDb()
    .prepare(
      `INSERT INTO refresh_run_storefronts (
         run_id, country, eligible, refreshed, failed, skipped,
         popularity_failed, abandoned, failure_reasons_json, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, country) DO UPDATE SET
         eligible = excluded.eligible,
         refreshed = excluded.refreshed,
         failed = excluded.failed,
         skipped = excluded.skipped,
         popularity_failed = excluded.popularity_failed,
         abandoned = excluded.abandoned,
         failure_reasons_json = excluded.failure_reasons_json,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at`
    )
    .run(
      runId,
      row.country,
      row.eligible,
      row.refreshed,
      row.failed,
      row.skipped,
      row.popularityFailed,
      row.abandoned ? 1 : 0,
      JSON.stringify(row.failureReasons ?? {}),
      row.startedAt,
      row.finishedAt
    );
}

export function finishRefreshRun(
  runId: number,
  params: {
    status: RefreshRunStatus;
    finishedAt: string;
    counters: Record<string, unknown>;
    lastError: string | null;
  }
): void {
  getDb()
    .prepare(
      `UPDATE refresh_runs
       SET status = ?, finished_at = ?, counters_json = ?, last_error = ?
       WHERE id = ?`
    )
    .run(
      params.status,
      params.finishedAt,
      JSON.stringify(params.counters),
      params.lastError,
      runId
    );
}

/**
 * Marks every run left unfinished by a previous process as interrupted.
 * Call once at startup, before any new run begins.
 */
export function markUnfinishedRefreshRunsInterrupted(): number {
  const result = getDb()
    .prepare(
      `UPDATE refresh_runs
       SET status = 'interrupted',
           last_error = COALESCE(last_error, 'Process exited before the run finished.')
       WHERE finished_at IS NULL AND status = 'running'`
    )
    .run();
  return result.changes;
}

export function getLatestRefreshRun(
  triggers?: string[]
): RefreshRunRow | null {
  const db = getDb();
  const row =
    triggers && triggers.length > 0
      ? (db
          .prepare(
            `SELECT * FROM refresh_runs
             WHERE trigger IN (${triggers.map(() => "?").join(",")})
             ORDER BY id DESC LIMIT 1`
          )
          .get(...triggers) as RawRunRow | undefined)
      : (db
          .prepare(`SELECT * FROM refresh_runs ORDER BY id DESC LIMIT 1`)
          .get() as RawRunRow | undefined);
  return row ? toRunRow(row) : null;
}

/**
 * Latest run that ran to the end. "failed" counts: it means some storefront
 * or the session had a problem, not that the crawl stopped early.
 */
export function getLatestFinishedRefreshRun(): RefreshRunRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM refresh_runs
       WHERE finished_at IS NOT NULL AND status IN ('completed', 'failed')
       ORDER BY id DESC LIMIT 1`
    )
    .get() as RawRunRow | undefined;
  return row ? toRunRow(row) : null;
}

export function countRefreshRunsSince(trigger: string, sinceIso: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM refresh_runs WHERE trigger = ? AND started_at >= ?`
    )
    .get(trigger, sinceIso) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function listRefreshRunStorefronts(
  runId: number
): RefreshRunStorefrontRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM refresh_run_storefronts WHERE run_id = ? ORDER BY rowid`
    )
    .all(runId) as RawStorefrontRow[];
  return rows.map(toStorefrontRow);
}

/**
 * Per storefront, when it last finished a pass that worked: not abandoned,
 * and either something was refreshed or there was nothing to do.
 */
export function listStorefrontLastSuccessAt(): Record<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT country, MAX(finished_at) AS last_success_at
       FROM refresh_run_storefronts
       WHERE finished_at IS NOT NULL
         AND abandoned = 0
         AND (refreshed > 0 OR eligible = 0)
       GROUP BY country`
    )
    .all() as Array<{ country: string; last_success_at: string | null }>;
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.last_success_at) out[row.country] = row.last_success_at;
  }
  return out;
}

/** Countries with any recorded storefront row, successful or not. */
export function listCountriesWithRunHistory(): Set<string> {
  const rows = getDb()
    .prepare(`SELECT DISTINCT country FROM refresh_run_storefronts`)
    .all() as Array<{ country: string }>;
  return new Set(rows.map((row) => row.country));
}

/** Newest keyword write per storefront; the fallback before any run history exists. */
export function listKeywordLastUpdatedAt(): Record<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT country, MAX(updated_at) AS updated_at FROM aso_keywords GROUP BY country`
    )
    .all() as Array<{ country: string; updated_at: string | null }>;
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.updated_at) out[row.country] = row.updated_at;
  }
  return out;
}

/** Keeps the table small; a year of daily runs is ~400 rows. */
export function pruneRefreshRuns(olderThanIso: string): number {
  const db = getDb();
  return db.transaction(() => {
    db.prepare(
      `DELETE FROM refresh_run_storefronts
       WHERE run_id IN (SELECT id FROM refresh_runs WHERE started_at < ?)`
    ).run(olderThanIso);
    return db
      .prepare(`DELETE FROM refresh_runs WHERE started_at < ?`)
      .run(olderThanIso).changes;
  })();
}
