# HTTP API reference

Every route the dashboard server exposes, what it costs to call, and which ones
are safe for automation.

The server is the same process that serves the dashboard UI — there is no
separate API service. Deployment is covered in [deployment.md](deployment.md).

---

## Base URLs

| From | URL | Notes |
|---|---|---|
| Automation on the same Docker network (n8n) | `http://asocli:3456` | No TLS, no public round trip, unaffected by certificate or DNS problems. **Prefer this.** |
| Anywhere else | `https://keywords.chunks.app` | Behind Caddy. Cloudflare's free tier times requests out at 100s. |

## Authentication

Every request needs a bearer token — including `/` and the static assets. The
only exceptions are the liveness probes `/health` and `/livez`.

```bash
curl -H "Authorization: Bearer $ASO_API_TOKEN" \
  http://asocli:3456/api/aso/storefronts
```

In n8n use a **Header Auth** credential (`Authorization` / `Bearer <token>`).

**Read-only token.** Set `ASO_API_READ_TOKEN` (32+ characters, different from
`ASO_API_TOKEN`) to give a consumer that only reads a token that can do
nothing else. It may only `GET` these pure database reads:
`/api/aso/keywords`, `/api/aso/position-history`, `/api/aso/autocomplete`,
`/api/aso/refresh-status`, `/api/aso/health`, `/api/aso/v1/observations` and
`/api/aso/storefronts`. Anything else with it - a write, the dashboard, an
endpoint that calls Apple - is `403 AUTHORIZATION_FAILED`. The full token keeps
working everywhere.

Browsers never hold the token: Caddy authenticates the human with basic auth and
injects the bearer upstream. A request that already carries a bearer skips the
basic-auth challenge and is validated by the app, so that path is not a way in.

With `ASO_API_TOKEN` unset the guard is disabled entirely — that is the local
development mode, and the server then refuses to bind to anything but loopback.

## Response envelope

Success:

```json
{ "success": true, "data": { } }
```

Failure:

```json
{ "success": false, "errorCode": "COUNTRY_NOT_ENABLED", "error": "Storefront ZZ is not enabled. Enabled storefronts: US, AU, CA, ..." }
```

`errorCode` is stable and worth branching on; `error` is human-readable and may
be reworded.

| `errorCode` | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | Missing or malformed parameter |
| `COUNTRY_NOT_ENABLED` | 400 | Storefront absent from `ASO_SUPPORTED_COUNTRIES` |
| `AUTH_REQUIRED` | 401 | **Ambiguous** — either a bad API token, or the Apple session expired. Probe `/health` to tell them apart |
| `AUTHORIZATION_FAILED` | 403 | Cross-origin write rejected |
| `PRIMARY_APP_ID_RECONFIGURE_REQUIRED` | 403 | The configured primary App ID is not accessible to the Apple Ads account |
| `NOT_FOUND` | 404 | Unknown keyword or app |
| `AUTH_IN_PROGRESS` | 409 | An interactive Apple login is parked, waiting for a human |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 1 MB |
| `RATE_LIMITED` | 429 | Apple throttled the request |
| `REQUEST_TIMEOUT`, `NETWORK_ERROR`, `INTERNAL_ERROR` | 500 | Upstream or internal failure |

All responses carry `Cache-Control: no-store`.

---

## Cost classes — read this before wiring anything up

The endpoints do **not** all behave like a database. Three groups:

**Safe to poll.** Pure SQLite reads, no outbound traffic, no writes.

`/health` · `/livez` · `/api/aso/health` (writes one metadata row as its DB
check) · `/api/aso/keywords` · `/api/aso/keywords/history` ·
`/api/aso/storefronts` · `/api/aso/refresh-status` · `/api/aso/auth/status` ·
`/api/aso/setup/status` · `/api/dashboard/settings`

**Triggers Apple or SensorTower as a side effect of a GET.** Slow, writes to the
database, can fail with `AUTH_REQUIRED`, and counts against Apple's
per-storefront throttling.

| Endpoint | What it does behind your back |
|---|---|
| `GET /api/apps` | Refreshes any owned-app doc older than 24h against Apple |
| `GET /api/aso/top-apps` | Re-crawls the ranking if stale, hydrates missing app docs one request each, then calls SensorTower |
| `GET /api/aso/apps` | Fetches missing or expired docs; `refresh=1` forces a lookup of everything asked for |
| `GET /api/aso/apps/search` | Always performs a live App Store search |

**These exist for the dashboard, which needs live data when a human is looking
at it. Automation should not call them.** They are the difference between a
report that reads the database and one that quietly re-crawls the App Store
every time it runs.

The consequences of scheduling one are not theoretical: Apple throttles the
app-detail endpoint per storefront and returns 403 once a burst is too large,
which blocks that storefront for the client that tripped it. Recovery takes
seconds, but a report that re-crawls on every run keeps re-tripping it. A crawl of all 11 storefronts in quick succession is what
caused that during testing.

If a report needs competitor titles, subtitles or download estimates, take them
from a manual `top-apps` call while building it, or read `orderedAppIds` from
`/api/aso/keywords` — that ranked list is already in the database and costs
nothing.

**Mutating.** Everything else.

The server refreshes itself daily (`ASO_REFRESH_DAILY_AT`), so automation should
only ever read. Reaching for a fetch-triggering endpoint to "get fresh data" is
the mistake this section exists to prevent.

---

# Reading keyword data

## `GET /api/aso/keywords`

The main endpoint. Paged keywords for one app in one storefront, joined with
this app's ranking position. Pure database read.

| Parameter | Required | Default | Notes |
|---|---|---|---|
| `country` | yes | — | Must be enabled, else 400 |
| `appId` | yes | — | Your App Store ID, e.g. `6692632196` |
| `page` | | 1 | |
| `pageSize` | | 100 | Max 500 |
| `keyword` | | — | Case-insensitive substring filter |
| `minPopularity` | | 0 | |
| `maxDifficulty` | | 100 | |
| `brand` | | `all` | `all` \| `brand` \| `non_brand` |
| `favorite` | | `all` | `all` \| `favorite` \| `non_favorite` |
| `minRank`, `maxRank` | | 0, 201 | |
| `sortBy` | | `updatedAt` | `keyword` \| `popularity` \| `difficulty` \| `appCount` \| `rank` \| `change` \| `addedAt` \| `updatedAt` |
| `sortDir` | | `desc` | `asc` \| `desc` |

```bash
curl -H "Authorization: Bearer $ASO_API_TOKEN" \
  "http://asocli:3456/api/aso/keywords?country=GB&appId=6692632196&pageSize=500&sortBy=rank&sortDir=asc"
```

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "keyword": "wikipedia",
        "normalizedKeyword": "wikipedia",
        "country": "GB",
        "popularity": 54,
        "difficultyScore": 29,
        "minDifficultyScore": 15,
        "isBrandKeyword": false,
        "appCount": 248,
        "keywordMatch": "titleExactPhrase",
        "orderedAppIds": ["324715238", "334325516", "..."],
        "isFavorite": false,
        "createdAt": "2026-07-27T15:22:04.626Z",
        "addedAt": "2026-07-27T15:56:40.583Z",
        "updatedAt": "2026-07-27T15:26:58.123Z",
        "orderExpiresAt": "2026-07-28T15:26:58.123Z",
        "popularityExpiresAt": "2026-08-26T15:22:04.625Z",
        "keywordStatus": "ok",
        "failure": null,
        "positions": [
          { "appId": "6692632196", "previousPosition": null, "currentPosition": 76 }
        ]
      }
    ],
    "page": 1,
    "pageSize": 500,
    "totalCount": 14,
    "totalPages": 1,
    "hasPrevPage": false,
    "hasNextPage": false,
    "associatedCount": 14,
    "failedCount": 0,
    "pendingCount": 0
  }
}
```

Field notes that matter for reporting:

- **`positions`** is the ranking for *tracked* apps, not every app. Find your own
  entry by `appId`. `currentPosition` is 1-based; **`null` means the app is not in
  the ranked list at all**, which is different from a bad rank.
- **Rank improvements are negative deltas.** `previousPosition - currentPosition`
  is positive when you have moved *up*.
- **`popularity` is account-level, not per storefront.** Apple returns the same
  score for a term regardless of country. `difficultyScore`, `appCount`, `rank`,
  `keywordMatch` and `isBrandKeyword` *are* genuinely per storefront.
- **`keywordStatus`** is `ok` | `pending` | `failed`. `failure` carries the
  reason when failed. Use `failedCount` / `pendingCount` as a coverage caveat in
  any report — a "no movement" day and a "half the crawl failed" day look
  identical otherwise.
- **`orderedAppIds`** is Apple's ranked list, roughly 250 ids. Your competitors
  are in here, in order, for free.
- `updatedAt` tells you when the row was last crawled; if it is older than a day,
  the scheduler did not run or the storefront was skipped.

## `GET /api/aso/keywords/history`

Rank over time for one app/keyword/storefront. Pure database read. Retained 730
days (two years); points are written by each refresh.

```bash
curl -H "Authorization: Bearer $ASO_API_TOKEN" \
  "http://asocli:3456/api/aso/keywords/history?country=GB&appId=6692632196&keyword=wikipedia"
```

```json
{ "success": true, "data": { "appId": "6692632196", "keyword": "wikipedia", "points": [ { "capturedAt": "2026-07-28T02:14:11.031Z", "position": 76 } ] } }
```

A point is only recorded when the app actually appears in the ranked list, so
gaps mean "not ranking", not "not measured". Empty until the scheduler has run
at least twice.

## `GET /api/aso/position-history`

Free (SQLite only). Daily rank history for export — one point per app,
keyword, country and UTC day, taken from the day's last capture. Includes
history imported from Astro (`scripts/astro/`).

| Param | Default | |
|---|---|---|
| `since` | 30 days ago | `YYYY-MM-DD`, inclusive |
| `appIds` | all | comma-separated |
| `limit` | 5000 | max 5000 |
| `after` | — | keyset cursor: pass the previous page's `nextCursor`. Preferred; `offset` is ignored when set |
| `offset` | 0 | page with `hasNextPage` (still supported; rescans skipped rows) |

```json
{"success":true,"data":{"items":[{"appId":"6692632196","keyword":"microlearning","country":"US","date":"2026-09-25","position":24}],"since":"2026-09-01","limit":5000,"offset":0,"hasNextPage":true,"nextCursor":"WyIyMDI2LTA5LTI1IiwiNjY5MjYzMjE5NiIsIm1pY3JvbGVhcm5pbmciLCJVUyJd"}}
```

`nextCursor` is null on the last page. A bad cursor is `400 INVALID_REQUEST`.

`position` null means the app was not in the ~250 results that day. Positions
below ~10 come from MZSearch order and are approximate (see
`docs/aso-difficulty-model.md`).

## `GET /api/aso/v1/observations`

Append-only feed of everything observed from Apple, one row per metric. Pure
read. Page forward with the cursor; each row is returned exactly once.

| Query | Default | Notes |
|---|---|---|
| `since_cursor` | `0` | Return rows with `id` greater than this. Store `nextCursor` and pass it back next time. |
| `limit` | `1000` | 1–5000 |

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 18231,
        "recordedAt": "2026-10-30T03:12:04.120Z",
        "sourceObservedAt": "2026-10-30T03:12:03.877Z",
        "country": "GB",
        "keyword": "microlearning",
        "metric": "rank",
        "value": 7,
        "source": "asocli/mzsearch+searchpage",
        "runId": 52,
        "appId": "6692632196",
        "rank": 7,
        "ranked": true,
        "rankDepth": 238,
        "popularityIsFloor": null,
        "difficultyModelVersion": null,
        "appCount": 238,
        "storefrontLanguage": "en-GB"
      }
    ],
    "nextCursor": 18231,
    "hasMore": true
  }
}
```

- `metric`: `rank` (one row per tracked app; `ranked: false`, `rank: null`
  when the app was not in the crawled order of `rankDepth` positions),
  `app_count`, `difficulty` (with `difficultyModelVersion`, e.g. `ratings-v1`),
  `popularity` (with `popularityIsFloor`).
- `source`: `asocli/mzsearch`, `asocli/searchpage`,
  `asocli/mzsearch+searchpage`, `asocli/legacy` for ranks;
  `asa-legacy` (account level), `asa-legacy-storefront`, `asa-insights`,
  `asa-insights-monthly` for popularity.
- `sourceObservedAt` is when Apple was asked; `recordedAt` when the row was
  written. `runId` is the background refresh run (`refresh_runs.id`), null for
  observations made by dashboard or CLI actions.
- Written only for real observations: a popularity-only update writes no rank
  rows, and a failed crawl writes nothing. Rows are kept
  `ASO_OBSERVATIONS_RETENTION_DAYS` (default 90) by `sourceObservedAt`, pruned
  once a day - poll at least weekly. Position history keeps its two years.
- Size: about 4 rows per keyword per daily run (one rank row per tracked app,
  plus app count and difficulty; popularity rows only when the score is
  re-fetched, ~monthly), ~250 bytes each with the index. 1,000 keywords is
  ~1 MB a day: ~90 MB at the 90-day default, ~730 MB if kept two years.
- Readable with the read-only token.

## `POST /api/aso/autocomplete/refresh` · `GET /api/aso/autocomplete`

Autocomplete demand signal. POST starts a background job (single-flight,
returns 202 at once) that re-measures tracked keywords not checked in 7
days: for each, the fewest letters typed (from 2) before App Store search
suggests the term, and its position in the suggestions (MZSearchHints). GET
returns the stored results:

```json
{"success":true,"data":{"country":"US","running":false,"items":[{"country":"US","keyword":"stoicism","lettersNeeded":4,"hintRank":3,"checkedAt":"2026-09-27T12:00:00.000Z"}]}}
```

`lettersNeeded: null` = never suggested. Use it where Apple's popularity is 5
(no data): a term suggested within a few letters is genuinely searched.

Each POST checks about a seventh of the storefront's tracked keywords (oldest
check first), so a daily trigger covers every keyword once a week rather than
all of them in one burst. Within a call each prefix is requested once (related
keywords share prefixes) and every request is preceded by a 250 ms pause.

## `GET /api/aso/storefronts`

Enabled storefronts. Pure read. Use it to drive a per-country loop rather than
hardcoding the list.

```json
{ "success": true, "data": { "storefronts": [ { "country": "US", "name": "United States", "isDefault": true }, { "country": "GB", "name": "United Kingdom", "isDefault": false } ], "defaultCountry": "US" } }
```

---

# Health and scheduling

## `GET /health` · `GET /livez`

Unauthenticated. Static `{"success":true}`, no database access. Liveness only:
they answer whenever the event loop does, including while every storefront has
silently stopped refreshing. Docker's `HEALTHCHECK` uses `/health`; `/livez` is
the same response under a name that says what it is. For "is the data
current?" use `/api/aso/health`.

## `GET /api/aso/health`

Authenticated. The truthful health report, built from the persisted run
history (`refresh_runs` / `refresh_run_storefronts`), so it survives restarts.
HTTP 200 for `ok` and `degraded`, **503 for `down`**.

```json
{
  "success": true,
  "data": {
    "status": "degraded",
    "reasons": ["storefront_stale:GB"],
    "checkedAt": "2026-10-29T12:00:00.000Z",
    "uptimeSeconds": 360000,
    "memory": { "rssMb": 301, "heapUsedMb": 98, "heapTotalMb": 150 },
    "db": { "writable": true, "error": null },
    "scheduler": {
      "enabled": true, "dailyAt": "04:00", "timeZone": "Europe/Prague",
      "nextRunAt": "2026-10-30T03:00:00.000Z", "lastRunAt": "2026-10-29T03:00:00.000Z"
    },
    "lastRun": {
      "id": 41, "trigger": "scheduled", "status": "failed",
      "startedAt": "2026-10-29T03:00:00.000Z", "finishedAt": "2026-10-29T03:31:12.000Z",
      "completed": true, "lastError": "All keywords failed (25) in GB batch 1/4",
      "eligible": 480, "refreshed": 430, "failed": 50, "popularityFailed": 3,
      "failuresByReason": { "HTTP_403": 50, "popularity:POPULARITY_MISSING": 3 }
    },
    "lastCompletedRunAt": "2026-10-29T03:31:12.000Z",
    "currentRun": { "status": "failed", "trigger": "scheduled", "startedAt": "2026-10-29T03:00:00.000Z", "requiresReauthentication": false },
    "storefronts": [
      {
        "country": "GB", "lastSuccessAt": "2026-10-27T03:20:00.000Z",
        "lastSuccessSource": "runs", "stale": true,
        "lastRun": { "eligible": 50, "refreshed": 0, "failed": 50, "skipped": 0, "popularityFailed": 0, "abandoned": true, "failureReasons": { "HTTP_403": 50 } }
      }
    ],
    "session": { "keeperEnabled": true, "lastOkAt": "2026-10-29T09:00:00.000Z", "lastCheckAt": "2026-10-29T09:00:00.000Z", "ok": true, "needsTwoFactor": false },
    "restartLoop": { "detected": false, "recentStarts": 1 }
  }
}
```

- **`status`**: `down` when the database cannot be written; otherwise
  `degraded` when any of `reasons` applies, else `ok`.
- **`reasons`**:
  - `storefront_stale:<CC>` — an enabled storefront has had no successful pass
    for over 30h. A pass succeeds when it was not abandoned and refreshed at
    least one keyword (or had none due). Before any run is recorded for a
    storefront, its newest keyword `updated_at` stands in
    (`lastSuccessSource: "keywords"`); with nothing at all on record a fresh
    process gets 30h of grace.
  - `no_completed_run_26h` — only when the scheduler is enabled: no run has
    reached its end (`completed` or `failed`) in 26h.
  - `two_factor_required` — the session keeper needs a human for 2FA.
  - `reauthentication_required` — the latest run found the Apple session dead.
  - `restart_loop` — 4+ process starts in 2h, or interrupted-run catch-ups hit
    `ASO_REFRESH_MAX_CATCHUPS_PER_DAY`.
  - `db_not_writable`.
- **`lastRun.completed`** is false for a run that is `running`, `stopped` or
  `interrupted` (the process died mid-run).
- **Failure reasons** are Apple/pipeline reason codes. `EMPTY_ORDER` and
  `ORDER_CONTRACT_DRIFT` mean MZSearch returned no usable order; the previous
  ranking was kept. `popularity:`-prefixed reasons are popularity failures,
  which no longer stop the ranking crawl.
- `memory` is the process's RSS and V8 heap, in MB.
- `lastRun.requests` (null for runs before this field existed): run
  `durationMs`, and per Apple host class (`mzsearch`, `searchpage`, `lookup`,
  `popularity`) `requests`, `status429`, `status403`, `status5xx`, `throttles`
  and `perMin`, plus the caps and effective rates at the end of the run.
  `rateLimits` is the current `{ capPerMin, effectivePerMin, reducedSince }` per
  host; `reducedSince` is set while a throttle has the rate halved. See
  docs/deployment.md "Request rates".

**Alerts.** The same conditions (stale storefront, no completed run in 26h,
restart loop) are emailed through the Resend alert path, at most once per day
per condition, checked hourly and after each run. A condition that clears
re-arms, so its next occurrence alerts straight away. 2FA keeps its existing
reauthentication email.

## `GET /api/aso/refresh-status`

State of the last/current crawl, plus the schedule. Pure read, and the first
thing a report should check.

```json
{
  "success": true,
  "data": {
    "status": "idle",
    "startedAt": null,
    "finishedAt": null,
    "lastError": null,
    "requiresReauthentication": false,
    "stopRequested": false,
    "trigger": null,
    "runId": null,
    "counters": {
      "eligibleKeywordCount": 0,
      "refreshedKeywordCount": 0,
      "failedKeywordCount": 0,
      "popularityFailedKeywordCount": 0,
      "skippedCountries": [],
      "storefronts": []
    },
    "schedule": {
      "enabled": true,
      "dailyAt": "04:00",
      "timeZone": "Europe/Prague",
      "nextRunAt": "2026-07-29T02:00:00.000Z",
      "lastRunAt": null
    }
  }
}
```

- `status`: `idle` | `running` | `completed` | `failed` | `stopped`
- **`requiresReauthentication: true`** is the authoritative "Apple session died"
  signal — the crawl aborts the moment it sees this. Alert on it.
- **`counters.skippedCountries`** lists storefronts abandoned mid-run because
  they looked throttled. A non-empty array means that storefront's data is a day
  stale.
- `schedule.nextRunAt` is UTC. 04:00 Prague is `02:00Z` in summer, `03:00Z` in
  winter.
- `trigger`: `scheduled` | `catch-up` | `manual` | `startup`. A `catch-up` re-runs
  a scheduled run that was missed or interrupted by a restart.
- **`failedKeywordCount`** counts keywords whose ranking was not refreshed (the
  stored row was kept). Partial failures leave `status` at `completed`; a batch
  with no successes sets `lastError` and makes it `failed`.
- `popularityFailedKeywordCount` counts popularity failures separately; those
  keywords still had their ranking re-crawled.
- `counters.storefronts[]` is the per-storefront breakdown
  (`eligible`, `refreshed`, `failed`, `skipped`, `popularityFailed`,
  `failureReasons`, `abandoned`). This state is in memory and resets on restart;
  `/api/aso/health` reads the persisted history.

## `GET /api/aso/auth/status`, `GET /api/aso/setup/status`

Interactive Apple login state. Pure reads.

```json
{ "success": true, "data": { "status": "idle", "updatedAt": null, "lastError": null, "requiresTerminalAction": false, "canPrompt": true, "pendingPrompt": null } }
```

A non-null `pendingPrompt` means a login is parked waiting for a human. One
lasting more than an hour is a wedged flow — it blocks all future logins until
the container restarts.

## `GET /api/dashboard/settings` · `PATCH /api/dashboard/settings`

```json
{ "success": true, "data": { "includeResearchAppsInKeywordRefresh": true, "refreshMode": "manual" } }
```

`refreshMode` only governs the one-shot refresh at container startup — it is
unrelated to the daily schedule. Keep it `manual` in a hosted deployment.

---

# Endpoints that reach out to Apple

These power the dashboard and behave exactly as intended when a human triggers
them. Documented here so automation can steer clear.

## `GET /api/apps`

> **Calls Apple.** Not for automation.

Lists tracked apps, and refreshes any owned app whose doc is older than 24h
against Apple as a side effect.

`?country=GB` — required.

```json
{ "success": true, "data": [ { "id": "6692632196", "kind": "owned", "name": "Chunks Microlearning", "averageUserRating": 5, "userRatingCount": 4, "previousAverageUserRating": 5, "previousUserRatingCount": 4, "icon": {}, "expiresAt": null, "lastFetchedAt": null, "lastKeywordAddedAt": "2026-07-27T21:51:08.694Z" } ] }
```

`kind` is `owned` or `research` — research entries are keyword scratchpads, not
real apps, and have no ranking columns.

## `GET /api/aso/top-apps`

> **Calls Apple and SensorTower.** Not for automation. The slowest endpoint here.

The top N apps ranking for a keyword, with their metadata and SensorTower
download/revenue estimates. Re-crawls if the stored ranking is stale, hydrates
missing app docs, and calls SensorTower.

`?country=` `&keyword=` `&limit=` (default 10, max 100).

Slow on a cold cache: roughly 8–10 seconds for 100 apps, since each uncached app
is a separate request to Apple.

Returns `keyword` plus `appDocs[]` with `appId`, `name`, `subtitle`,
`publisherName`, `averageUserRating`, `userRatingCount`, `releaseDate`,
`currentVersionReleaseDate`, `icon`, and where available `lastMonthDownloads`
and `lastMonthRevenue`.

**This is the endpoint that gives you competitor titles and subtitles.** Useful
on demand, not on a schedule.

## `GET /api/aso/apps`

> **Calls Apple** for anything missing or expired. Not for automation.

Metadata for specific app ids. `?country=` `&ids=` (comma-separated; there is no
cap, they are fetched in batches of 50) `&refresh=1` to force a live lookup. Without `refresh`, only missing or
expired docs are fetched — so it is *usually* cheap, but not guaranteed.

## `GET /api/aso/apps/search`

> **Always calls Apple.** Never safe for automation.

Free-text App Store search. `?country=` `&term=` `&limit=` (default 20, max 50).
Always performs a live search.

---

# Mutating endpoints

| Route | Body | Notes |
|---|---|---|
| `POST /api/apps` | `{"type":"app","appId":"123","country":"GB"}` or `{"type":"research","name":"..."}` | Adds a tracked app; hydrates from Apple |
| `DELETE /api/apps` | `{"appId":"123"}` | Removes the app and its keyword associations |
| `POST /api/aso/keywords` | `{"appId":"123","keywords":["a","b"],"country":"GB","defer":true}` | Max 100 per call. Returns `{cachedCount, pendingCount, failedCount}`. **`defer: true` records the keywords without contacting Apple** and lets the next refresh score them — the right choice for automation. Without it the call crawls synchronously and can exceed Cloudflare's 100s limit |
| `DELETE /api/aso/keywords` | `{"appId":"123","keywords":["a"],"country":"GB"}` | `{removedCount}` |
| `POST /api/aso/keywords/favorite` | `{"appId":"123","keyword":"a","isFavorite":true,"country":"GB"}` | 404 if not tracked |
| `POST /api/aso/keywords/retry-failed` | `{"appId":"123","country":"GB"}` | Re-crawls failed keywords |
| `POST /api/aso/refresh/start` \| `/stop` | — | Manual crawl control; 202. `?force=1` re-crawls every tracked keyword instead of only those past their 24h freshness window — that is what the dashboard's Refresh all button sends |
| `POST /api/aso/auth/start` \| `/respond` | see below | **Never call from automation** |
| `POST /api/aso/setup/start` \| `/respond` | | Primary App ID selection |

## Adding keywords from a script

`POST /api/aso/keywords` with `"defer": true` stores the keyword association and
returns immediately:

```json
{ "success": true, "data": { "cachedCount": 0, "pendingCount": 3, "failedCount": 0, "deferred": true } }
```

Popularity, difficulty and rank arrive on the next refresh, which picks up
tracked keywords that have no cached row yet. Nothing is lost and no Apple
session is needed at the moment of adding.

Even without `defer`, an expired Apple session no longer fails the request: the
keywords are recorded and the response is **202** with `deferred: true` and a
`warning`, rather than a 401 that would make a caller drop them and redo the work
by hand.

Adding an *app* (`POST /api/apps`) never needed the Search Ads session — it reads
public App Store pages — so that path was already safe.

## Why automation must not start the Apple login

The prompt session is a single slot. `POST /api/aso/auth/start` immediately
parks on a credentials prompt and holds it; a second attempt is rejected with
"Another interactive prompt is already pending". If n8n starts it unattended,
the flow sits waiting forever and *your* login in the browser is refused until
the container restarts.

Alert instead, and complete the login yourself at the dashboard. Apple requires
a 2FA code from a trusted device, so there is no unattended path regardless.

---

# n8n recipes

## Daily report

Run it after the 04:00 crawl.

1. `GET /api/aso/refresh-status` — if `requiresReauthentication`, alert and stop.
   Also check `counters.skippedCountries` and `schedule.nextRunAt`.
2. `GET /api/aso/storefronts` → split into one item per country.
3. Per country: `GET /api/aso/keywords?country={{ $json.country }}&appId=<id>&pageSize=500`.
4. Compute movers from `previousPosition - currentPosition` (positive = improved),
   and report `failedCount` / `pendingCount` as coverage.

Every call is a pure database read, so this is safe to run as often as you like.

## Tying keyword data to Apple Search Ads

The ASA reporting already in place gives spend, impressions and conversions per
keyword. This API gives, for the same term:

- `popularity` — Apple's own search-volume proxy, 0–100
- `difficultyScore` — how hard the organic result is to break into
- `positions[].currentPosition` — where the app currently ranks organically

Two questions that combination answers, neither of which either source answers
alone:

**Which ads are buying traffic already owned organically.** Join ASA keywords to
this endpoint and look for terms ranking in the organic top 5 with meaningful ad
spend. Those are candidates for reduced bids.

**Which high-popularity terms are not ranked and not bid.** `popularity` high,
`currentPosition` null, absent from ASA — an unexploited gap. `difficultyScore`
says whether organic is realistic or whether it has to be bought.

## Tying to App Store Connect metadata

The keyword field, title and subtitle in App Store Connect determine what the
app can rank for at all. Pull those alongside this API and check:

- Terms in the keyword field that are **not ranking anywhere** (`currentPosition`
  null across storefronts) — the field is finite at 100 characters, so those are
  wasted.
- Terms ranking well that are **absent from the metadata** — usually earned via
  the title or subtitle, worth protecting before any copy change.
- `keywordMatch` shows how the top-ranking apps match a term
  (`titleExactPhrase`, `titleAllWords`, `subtitleExactPhrase`, …). If the
  leaders all match on title and yours does not, that is the gap.

Storefront mapping matters here: metadata locales do not map one-to-one to
storefronts. Verified for this app — `en-GB` metadata serves GB, **CA, AU, IE and
NZ**; only US uses `en-US`. Compare a storefront against the locale that actually
serves it.

---

# Limits and gotchas

- **Cloudflare times out at 100 seconds** on the public hostname. Long calls
  (`POST /api/aso/keywords` with many terms, `top-apps` on a cold cache) can
  return 524 while the work continues server-side. The internal URL has no such
  limit.
- **Request bodies are capped at 1 MB** (413 beyond).
- **Apple throttles per storefront** and answers 403 once a burst is too large.
  Roughly 100–200 rapid requests to one storefront trips it; recovery takes
  seconds. The scheduler paces itself; ad-hoc calls to the fetch-triggering
  endpoints do not.
- **One instance only.** SQLite is single-writer.
- **`AUTH_REQUIRED` is ambiguous** — bad API token or dead Apple session. Probe
  `/health` first.
- **Popularity may or may not vary by storefront.** The legacy endpoint was
  always asked for the account-level score, which is the same everywhere. With
  `ASO_POPULARITY_PER_STOREFRONT` on (default) it is now asked for the
  storefront's own score first, falling back to account level per keyword for
  anything Apple rejects or leaves empty. Whether Apple really answers per
  storefront is unverified; each fetch logs
  `[aso-popularity] mode=storefront country=GB storefront=N account-fallback=M fallbackReason=...`.
  Until those logs show storefront answers that differ between countries,
  treat per-country popularity as account-level.
