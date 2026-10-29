import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { ASO_ENV } from "../shared/aso-env";
let db: Database.Database | null = null;

function ensureAppKeywordFavoriteColumn(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(app_keywords)`)
    .all() as Array<{ name?: string }>;
  const hasFavoriteColumn = columns.some((column) => column.name === "is_favorite");
  if (!hasFavoriteColumn) {
    database.exec(
      `ALTER TABLE app_keywords
       ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`
    );
  }
}

/**
 * Version of the schema created by `applyVersionedMigrations`, kept in
 * SQLite's `PRAGMA user_version`. The tables above predate it and stay on
 * their CREATE IF NOT EXISTS / column-sniffing path; anything added from now
 * on goes in a numbered step below so an existing database is upgraded
 * exactly once, in order.
 */
export const SCHEMA_VERSION = 3;

const VERSIONED_MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    // Refresh runs, so "did last night's refresh finish, and per storefront
    // how much of it worked?" survives a restart.
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS refresh_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        counters_json TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_runs_trigger_started
        ON refresh_runs(trigger, started_at);

      CREATE TABLE IF NOT EXISTS refresh_run_storefronts (
        run_id INTEGER NOT NULL,
        country TEXT NOT NULL,
        eligible INTEGER NOT NULL,
        refreshed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        popularity_failed INTEGER NOT NULL DEFAULT 0,
        abandoned INTEGER NOT NULL DEFAULT 0,
        failure_reasons_json TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, country),
        FOREIGN KEY (run_id) REFERENCES refresh_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_run_storefronts_country_finished
        ON refresh_run_storefronts(country, finished_at);
    `,
  },
  {
    // Append-only feed of every successful observation, read by consumers
    // through GET /api/aso/v1/observations with an id cursor.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS keyword_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        source_observed_at TEXT NOT NULL,
        country TEXT NOT NULL,
        keyword TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL,
        source TEXT NOT NULL,
        run_id INTEGER,
        app_id TEXT,
        rank INTEGER,
        ranked INTEGER,
        rank_depth INTEGER,
        popularity_is_floor INTEGER,
        difficulty_model_version TEXT,
        app_count INTEGER,
        storefront_language TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_keyword_observations_observed
        ON keyword_observations(source_observed_at);
    `,
  },
  {
    // Position history: the old lookup index (country, app_id, keyword,
    // captured_at) duplicated the primary key (app_id, keyword, country,
    // captured_at) - every query either pins app_id+keyword+country or
    // filters on captured_at, and none leads with country. What was missing
    // is captured_at on its own, for the daily export (captured_at >= ?)
    // and the two-year prune (captured_at < ?).
    version: 3,
    sql: `
      DROP INDEX IF EXISTS idx_app_keyword_position_history_lookup;
      CREATE INDEX IF NOT EXISTS idx_app_keyword_position_history_captured
        ON app_keyword_position_history(captured_at);
    `,
  },
];

function applyVersionedMigrations(database: Database.Database): void {
  const current = Number(database.pragma("user_version", { simple: true }) ?? 0);
  for (const migration of VERSIONED_MIGRATIONS) {
    if (migration.version <= current) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
    })();
  }
}

function initializeDatabase(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  // WAL + NORMAL is durable across process crashes (only an OS crash or power
  // loss can drop the last commits) and avoids an fsync per write.
  database.pragma("synchronous = NORMAL");
  // The dashboard and the background crawl share the file; wait briefly for a
  // lock instead of failing with SQLITE_BUSY.
  database.pragma("busy_timeout = 5000");
  database.pragma("temp_store = MEMORY");
  // 16 MB page cache (negative = KiB).
  database.pragma("cache_size = -16000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS owned_apps (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('owned', 'research')),
      name TEXT NOT NULL,
      icon_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_owned_apps_kind
      ON owned_apps(kind);

    CREATE TABLE IF NOT EXISTS owned_app_country_ratings (
      app_id TEXT NOT NULL,
      country TEXT NOT NULL,
      average_user_rating REAL,
      user_rating_count INTEGER,
      previous_average_user_rating REAL,
      previous_user_rating_count INTEGER,
      expires_at TEXT,
      last_fetched_at TEXT,
      PRIMARY KEY (app_id, country),
      FOREIGN KEY (app_id) REFERENCES owned_apps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_owned_app_country_ratings_country
      ON owned_app_country_ratings(country);
    CREATE INDEX IF NOT EXISTS idx_owned_app_country_ratings_app
      ON owned_app_country_ratings(app_id);

    CREATE TABLE IF NOT EXISTS aso_keywords (
      country TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      keyword TEXT NOT NULL,
      popularity REAL NOT NULL,
      difficulty_score REAL,
      min_difficulty_score REAL,
      is_brand_keyword INTEGER,
      app_count INTEGER,
      keyword_match TEXT CHECK (keyword_match IN (
        'none',
        'titleExactPhrase',
        'titleAllWords',
        'subtitleExactPhrase',
        'combinedPhrase',
        'subtitleAllWords'
      )),
      ordered_app_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      order_expires_at TEXT NOT NULL,
      popularity_expires_at TEXT NOT NULL,
      PRIMARY KEY (country, normalized_keyword)
    );
    CREATE INDEX IF NOT EXISTS idx_aso_keywords_country_order_expires
      ON aso_keywords(country, order_expires_at);

    CREATE TABLE IF NOT EXISTS aso_apps (
      country TEXT NOT NULL,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      subtitle TEXT,
      average_user_rating REAL NOT NULL,
      user_rating_count INTEGER NOT NULL,
      release_date TEXT,
      current_version_release_date TEXT,
      publisher_name TEXT,
      icon_json TEXT,
      icon_artwork_json TEXT,
      additional_localizations_json TEXT,
      expires_at TEXT,
      PRIMARY KEY (country, app_id)
    );

    CREATE TABLE IF NOT EXISTS sensor_tower_app_metrics (
      app_id TEXT PRIMARY KEY,
      last_month_downloads TEXT NOT NULL,
      last_month_revenue TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_keywords (
      app_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      country TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      previous_position INTEGER,
      added_at TEXT,
      PRIMARY KEY (app_id, keyword, country)
    );
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_app
      ON app_keywords(country, app_id);
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_keyword
      ON app_keywords(country, keyword);
    CREATE TABLE IF NOT EXISTS app_keyword_position_history (
      app_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      country TEXT NOT NULL,
      position INTEGER,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (app_id, keyword, country, captured_at)
    );

    CREATE TABLE IF NOT EXISTS aso_keyword_autocomplete (
      country TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      letters_needed INTEGER,
      hint_rank INTEGER,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (country, normalized_keyword)
    );

    CREATE TABLE IF NOT EXISTS aso_keyword_popularity_history (
      country TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      week TEXT NOT NULL,
      popularity REAL NOT NULL,
      genre TEXT,
      rank_in_genre INTEGER,
      PRIMARY KEY (country, normalized_keyword, week)
    );
    CREATE INDEX IF NOT EXISTS idx_aso_keyword_popularity_history_lookup
      ON aso_keyword_popularity_history(country, normalized_keyword, week);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS aso_keyword_failures (
      country TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      keyword TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      message TEXT NOT NULL,
      status_code INTEGER,
      retryable INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      request_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (country, normalized_keyword)
    );
    CREATE INDEX IF NOT EXISTS idx_aso_keyword_failures_country_stage
      ON aso_keyword_failures(country, stage);
  `);
  ensureAppKeywordFavoriteColumn(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_app_keywords_country_app_favorite
      ON app_keywords(country, app_id, is_favorite);
  `);
  applyVersionedMigrations(database);
}

export function getDbPath(): string {
  return ASO_ENV.dbPath;
}

export function getDb(): Database.Database {
  if (db) {
    return db;
  }
  const dbPath = ASO_ENV.dbPath;
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(dbPath);
  initializeDatabase(db);
  return db;
}

/**
 * Checkpoint and close the database. Safe to call when nothing is open.
 *
 * WAL means an abrupt kill is not corrupting, so this is about leaving a tidy
 * single file behind on shutdown rather than about durability.
 */
/**
 * Runs `fn` in one transaction (a savepoint when already inside one), so a
 * batch of writes costs one commit instead of one per statement.
 */
export function withTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

/** Lets SQLite refresh its planner statistics. Cheap; run daily and on close. */
export function optimizeDb(): void {
  if (!db) return;
  try {
    db.pragma("optimize");
  } catch {
    // Statistics only; never worth failing for.
  }
}

export function closeDb(): void {
  if (!db) return;
  optimizeDb();
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // A checkpoint failure must not prevent the close below.
  }
  db.close();
  db = null;
}

export function closeDbForTests(): void {
  closeDb();
}
