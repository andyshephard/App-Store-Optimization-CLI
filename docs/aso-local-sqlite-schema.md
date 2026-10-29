# ASO Local SQLite Schema

## Scope
Canonical schema for local SQLite docs in `~/.aso/aso-db.sqlite` (or `ASO_DB_PATH`).

## ER Diagram
```mermaid
erDiagram
  OWNED_APPS {
    TEXT id PK
    TEXT kind
    TEXT name
    TEXT icon_json
  }

  OWNED_APP_COUNTRY_RATINGS {
    TEXT app_id PK
    TEXT country PK
    REAL average_user_rating
    INTEGER user_rating_count
    REAL previous_average_user_rating
    INTEGER previous_user_rating_count
    TEXT expires_at
    TEXT last_fetched_at
  }

  ASO_KEYWORDS {
    TEXT country PK
    TEXT normalized_keyword PK
    TEXT keyword
    REAL popularity
    REAL difficulty_score
    REAL min_difficulty_score
    INTEGER is_brand_keyword
    INTEGER app_count
    TEXT keyword_match
    TEXT ordered_app_ids
    TEXT created_at
    TEXT updated_at
    TEXT order_expires_at
    TEXT popularity_expires_at
  }

  ASO_APPS {
    TEXT country PK
    TEXT app_id PK
    TEXT name
    TEXT subtitle
    TEXT publisher_name
    REAL average_user_rating
    INTEGER user_rating_count
    TEXT release_date
    TEXT current_version_release_date
    TEXT icon_json
    TEXT icon_artwork_json
    TEXT additional_localizations_json
    TEXT expires_at
  }

  SENSOR_TOWER_APP_METRICS {
    TEXT app_id PK
    TEXT last_month_downloads
    TEXT last_month_revenue
    TEXT fetched_at
  }

  APP_KEYWORDS {
    TEXT app_id PK
    TEXT keyword PK
    TEXT country PK
    INTEGER is_favorite
    INTEGER previous_position
    TEXT added_at
  }

  APP_KEYWORD_POSITION_HISTORY {
    TEXT app_id PK
    TEXT keyword PK
    TEXT country PK
    INTEGER position
    TEXT captured_at PK
  }

  METADATA {
    TEXT key PK
    TEXT value
    TEXT updated_at
  }

  ASO_KEYWORD_FAILURES {
    TEXT country PK
    TEXT normalized_keyword PK
    TEXT keyword
    TEXT status
    TEXT stage
    TEXT reason_code
    TEXT message
    INTEGER status_code
    INTEGER retryable
    INTEGER attempts
    TEXT request_id
    TEXT updated_at
  }

  OWNED_APPS ||--o{ OWNED_APP_COUNTRY_RATINGS : "app_id link"
  OWNED_APPS ||--o{ APP_KEYWORDS : "logical app_id link"
  APP_KEYWORDS ||--o{ APP_KEYWORD_POSITION_HISTORY : "logical app+keyword history"
  ASO_KEYWORDS ||--o{ APP_KEYWORDS : "logical country+keyword link"
  ASO_KEYWORDS ||--o| ASO_KEYWORD_FAILURES : "logical country+normalized_keyword link"
  ASO_KEYWORDS ||--o{ ASO_APPS : "ordered_app_ids[] contains app_id"
```

## Table Schemas

### `owned_apps`
| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `id` | `TEXT` | `string` | No | PK |
| `kind` | `TEXT` | `"owned" \| "research"` | No | `CHECK(kind IN ('owned','research'))` |
| `name` | `TEXT` | `string` | No | Display name |
| `icon_json` | `TEXT` | `Record<string, unknown> \| null` | Yes | JSON-encoded icon payload |

Indexes:
- PK: (`id`)
- `idx_owned_apps_kind`: (`kind`)

### `owned_app_country_ratings`
Country-scoped owned-app rating snapshots.

| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `app_id` | `TEXT` | `string` | No | PK part; FK to `owned_apps.id` |
| `country` | `TEXT` | `string` | No | PK part |
| `average_user_rating` | `REAL` | `number \| null` | Yes | Current rating snapshot |
| `user_rating_count` | `INTEGER` | `number \| null` | Yes | Current rating-count snapshot |
| `previous_average_user_rating` | `REAL` | `number \| null` | Yes | Previous rating snapshot |
| `previous_user_rating_count` | `INTEGER` | `number \| null` | Yes | Previous rating-count snapshot |
| `expires_at` | `TEXT` | `string \| null` | Yes | ISO datetime TTL |
| `last_fetched_at` | `TEXT` | `string \| null` | Yes | ISO datetime latest fetch for this app+country |

Indexes:
- PK: (`app_id`, `country`)
- `idx_owned_app_country_ratings_country`: (`country`)
- `idx_owned_app_country_ratings_app`: (`app_id`)

### `aso_keywords`
| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `country` | `TEXT` | `string` | No | PK part (`US`) |
| `normalized_keyword` | `TEXT` | `string` | No | PK part |
| `keyword` | `TEXT` | `string` | No | Display keyword |
| `popularity` | `REAL` | `number` | No | Search Ads popularity |
| `difficulty_score` | `REAL` | `number \| null` | Yes | Rounded integer semantics on write |
| `min_difficulty_score` | `REAL` | `number \| null` | Yes | Rounded integer semantics on write |
| `is_brand_keyword` | `INTEGER` | `boolean \| null` | Yes | `1` brand, `0` non-brand, `NULL` not computed yet |
| `app_count` | `INTEGER` | `number \| null` | Yes | Ordered app count |
| `keyword_match` | `TEXT` | `"none" \| "titleExactPhrase" \| "titleAllWords" \| "subtitleExactPhrase" \| "combinedPhrase" \| "subtitleAllWords" \| null` | Yes | Best (highest-ranked) keyword match enum across top 5 apps |
| `ordered_app_ids` | `TEXT` | `string[]` | No | JSON-encoded app id list |
| `created_at` | `TEXT` | `string` | No | ISO datetime |
| `updated_at` | `TEXT` | `string` | No | ISO datetime |
| `order_expires_at` | `TEXT` | `string` | No | Order TTL |
| `popularity_expires_at` | `TEXT` | `string` | No | Popularity/difficulty TTL |

Indexes:
- PK: (`country`, `normalized_keyword`)
- `idx_aso_keywords_country_order_expires`: (`country`, `order_expires_at`)

### `aso_apps`
Competitor app-doc cache only (country-scoped).

| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `country` | `TEXT` | `string` | No | PK part |
| `app_id` | `TEXT` | `string` | No | PK part |
| `name` | `TEXT` | `string` | No | App name |
| `subtitle` | `TEXT` | `string \| null` | Yes | App subtitle |
| `publisher_name` | `TEXT` | `string \| null` | Yes | Canonical publisher/developer cache for brand detection |
| `average_user_rating` | `REAL` | `number` | No | Rating |
| `user_rating_count` | `INTEGER` | `number` | No | Rating count |
| `release_date` | `TEXT` | `string \| null` | Yes | Release date |
| `current_version_release_date` | `TEXT` | `string \| null` | Yes | Current version release date |
| `icon_json` | `TEXT` | `Record<string, unknown> \| null` | Yes | JSON-encoded icon payload |
| `icon_artwork_json` | `TEXT` | `Record<string, unknown> \| null` | Yes | JSON-encoded icon artwork payload |
| `additional_localizations_json` | `TEXT` | `Record<string, { name: string; subtitle?: string }> \| null` | Yes | JSON-encoded locale map used for keyword inclusion/difficulty matching (non-default locales) |
| `expires_at` | `TEXT` | `string \| null` | Yes | ISO datetime TTL |

Indexes:
- PK: (`country`, `app_id`)

### `sensor_tower_app_metrics`
Worldwide Sensor Tower metrics cache, independent of storefront.

| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `app_id` | `TEXT` | `string` | No | PK; numeric iOS app ID |
| `last_month_downloads` | `TEXT` | `string` | No | Sensor Tower humanized worldwide last-month downloads |
| `last_month_revenue` | `TEXT` | `string` | No | Sensor Tower humanized worldwide last-month revenue |
| `fetched_at` | `TEXT` | `string` | No | ISO datetime of the successful fetch |

Indexes:
- PK: (`app_id`)

### `app_keywords`
| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `app_id` | `TEXT` | `string` | No | PK part; logical link to `owned_apps.id` |
| `keyword` | `TEXT` | `string` | No | PK part; normalized keyword |
| `country` | `TEXT` | `string` | No | PK part |
| `is_favorite` | `INTEGER` | `boolean` | No | App-scoped favorite flag (`1` favorite / `0` non-favorite) |
| `previous_position` | `INTEGER` | `number \| null` | Yes | Rank delta baseline |
| `added_at` | `TEXT` | `string \| null` | Yes | Association timestamp |

Indexes:
- PK: (`app_id`, `keyword`, `country`)
- `idx_app_keywords_country_app`: (`country`, `app_id`)
- `idx_app_keywords_country_app_favorite`: (`country`, `app_id`, `is_favorite`)
- `idx_app_keywords_country_keyword`: (`country`, `keyword`)

### `app_keyword_position_history`
Append-only rank snapshots for associated `(app, keyword, country)` rows.

| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `app_id` | `TEXT` | `string` | No | PK part |
| `keyword` | `TEXT` | `string` | No | PK part; normalized keyword |
| `country` | `TEXT` | `string` | No | PK part |
| `position` | `INTEGER` | `number \| null` | Yes | Captured rank (smaller is better) |
| `captured_at` | `TEXT` | `string` | No | PK part; ISO datetime capture point |

Indexes:
- PK: (`app_id`, `keyword`, `country`, `captured_at`)
- `idx_app_keyword_position_history_captured`: (`captured_at`) — schema version 3, which also dropped the old `idx_app_keyword_position_history_lookup` (it duplicated the primary key)

### `aso_keyword_popularity_history`
Weekly per-storefront popularity points from the Apple Ads Platform API
insights dataset (Sunday-start weeks). Written only when Ads API credentials
are configured; drives the dashboard popularity trend.

| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `country` | `TEXT` | `string` | No | PK part |
| `normalized_keyword` | `TEXT` | `string` | No | PK part |
| `week` | `TEXT` | `string` | No | PK part; week start date `YYYY-MM-DD` |
| `popularity` | `REAL` | `number` | No | Country-wide 1-100 score |
| `genre` | `TEXT` | `string \| null` | Yes | Best genre the term charted in |
| `rank_in_genre` | `INTEGER` | `number \| null` | Yes | Rank within that genre's top 500 |

Indexes:
- PK: (`country`, `normalized_keyword`, `week`)
- `idx_aso_keyword_popularity_history_lookup`: (`country`, `normalized_keyword`, `week`)

### `metadata`
| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `key` | `TEXT` | `string` | No | PK |
| `value` | `TEXT` | `string` | No | Metadata value |
| `updated_at` | `TEXT` | `string` | No | ISO datetime |

Known runtime key:
- `aso-popularity-adam-id`
- `app-keyword-position-history-pruned-at` (daily prune watermark for 90-day history retention)

### `aso_keyword_failures`
| Column | SQLite Type | TS Type | Nullable | Notes |
|---|---|---|---|---|
| `country` | `TEXT` | `string` | No | PK part |
| `normalized_keyword` | `TEXT` | `string` | No | PK part |
| `keyword` | `TEXT` | `string` | No | Normalized keyword |
| `status` | `TEXT` | `"failed"` | No | Terminal status |
| `stage` | `TEXT` | `"popularity" \| "enrichment"` | No | Failure stage |
| `reason_code` | `TEXT` | `string` | No | Normalized reason |
| `message` | `TEXT` | `string` | No | User/debug message |
| `status_code` | `INTEGER` | `number \| null` | Yes | Upstream/HTTP status |
| `retryable` | `INTEGER` | `boolean` | No | `1` retryable, `0` non-retryable |
| `attempts` | `INTEGER` | `number` | No | Attempt count |
| `request_id` | `TEXT` | `string \| null` | Yes | Upstream request id |
| `updated_at` | `TEXT` | `string` | No | ISO datetime |

Indexes:
- PK: (`country`, `normalized_keyword`)
- `idx_aso_keyword_failures_country_stage`: (`country`, `stage`)

### `refresh_runs`

One row per background refresh run (schema version 1). Written when the run
starts, stamped when it finishes. A row still `running` at the next startup
belonged to a process that died and is marked `interrupted`. Rows older than
180 days are pruned at startup.

| Column | SQLite type | App type | Nullable | Notes |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | `number` | No | PK, autoincrement |
| `started_at` | `TEXT` | `string` | No | ISO datetime |
| `finished_at` | `TEXT` | `string \| null` | Yes | Null while running or when interrupted |
| `status` | `TEXT` | `"running" \| "completed" \| "failed" \| "stopped" \| "interrupted"` | No | |
| `trigger` | `TEXT` | `"scheduled" \| "catch-up" \| "manual" \| "startup"` | No | |
| `counters_json` | `TEXT` | `StartupRefreshCounters` | Yes | Run totals and per-storefront breakdown |
| `last_error` | `TEXT` | `string \| null` | Yes | First error of the run |

Indexes:
- `idx_refresh_runs_trigger_started`: (`trigger`, `started_at`)

### `refresh_run_storefronts`

One row per storefront per run, written when that storefront finishes.

| Column | SQLite type | App type | Nullable | Notes |
| --- | --- | --- | --- | --- |
| `run_id` | `INTEGER` | `number` | No | PK part, FK to `refresh_runs.id` (`ON DELETE CASCADE`) |
| `country` | `TEXT` | `string` | No | PK part |
| `eligible` | `INTEGER` | `number` | No | Keywords selected for this pass |
| `refreshed` | `INTEGER` | `number` | No | Ranking re-crawled (or newly enriched) |
| `failed` | `INTEGER` | `number` | No | Ranking not refreshed; stored row left as it was |
| `skipped` | `INTEGER` | `number` | No | Not attempted (stop, abandoned storefront, no session for a new keyword) |
| `popularity_failed` | `INTEGER` | `number` | No | Popularity not refreshed (ranking may still have been) |
| `abandoned` | `INTEGER` | `boolean` | No | Storefront given up as throttled |
| `failure_reasons_json` | `TEXT` | `Record<string, number>` | Yes | reasonCode -> count; popularity reasons prefixed `popularity:` |
| `started_at` | `TEXT` | `string \| null` | Yes | ISO datetime |
| `finished_at` | `TEXT` | `string \| null` | Yes | ISO datetime |

Indexes:
- PK: (`run_id`, `country`)
- `idx_refresh_run_storefronts_country_finished`: (`country`, `finished_at`)

### `keyword_observations`

Append-only observations feed (schema version 2), served by
`GET /api/aso/v1/observations`. `id` is the cursor. Columns: `id` (PK,
autoincrement), `recorded_at`, `source_observed_at` (ISO; indexed, used for the
two-year prune), `country`, `keyword` (normalized), `metric`
(`rank` | `popularity` | `difficulty` | `app_count`), `value`, `source`,
`run_id`, `app_id`, `rank`, `ranked` (0/1), `rank_depth`,
`popularity_is_floor` (0/1), `difficulty_model_version`, `app_count`,
`storefront_language`. Kept `ASO_OBSERVATIONS_RETENTION_DAYS` (default 90),
pruned daily; ~1 MB a day per 1,000 tracked keywords.

## Notes
- New tables are added through numbered steps in `store.ts`
  (`VERSIONED_MIGRATIONS`), tracked in `PRAGMA user_version`. The older tables
  predate it and keep their `CREATE TABLE IF NOT EXISTS` path.
- DB init applies `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
- `owned_app_country_ratings.app_id` has FK to `owned_apps.id` (`ON DELETE CASCADE`).
- ASO keyword/app-doc tables keep logical links enforced at service layer.
