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
only exception is `/health`.

```bash
curl -H "Authorization: Bearer $ASO_API_TOKEN" \
  http://asocli:3456/api/aso/storefronts
```

In n8n use a **Header Auth** credential (`Authorization` / `Bearer <token>`).

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

`/health` · `/api/aso/keywords` · `/api/aso/keywords/history` ·
`/api/aso/storefronts` · `/api/aso/refresh-status` · `/api/aso/auth/status` ·
`/api/aso/setup/status` · `/api/dashboard/settings`

**Triggers Apple or SensorTower as a side effect of a GET.** Slow, writes to the
database, can fail with `AUTH_REQUIRED`, and counts against Apple's per-storefront
throttling. Do not put these on a schedule.

`/api/apps` (refreshes owned-app docs older than 24h) ·
`/api/aso/top-apps` (re-crawls stale rankings, hydrates app docs, calls
SensorTower) · `/api/aso/apps` (`refresh=1` forces a lookup) ·
`/api/aso/apps/search` (always a live search)

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

Rank over time for one app/keyword/storefront. Pure database read. Retained 90
days; points are written by each refresh.

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

## `GET /api/aso/storefronts`

Enabled storefronts. Pure read. Use it to drive a per-country loop rather than
hardcoding the list.

```json
{ "success": true, "data": { "storefronts": [ { "country": "US", "name": "United States", "isDefault": true }, { "country": "GB", "name": "United Kingdom", "isDefault": false } ], "defaultCountry": "US" } }
```

---

# Health and scheduling

## `GET /health`

Unauthenticated. Static `{"success":true}`, no database access. For uptime
probes.

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
    "counters": {
      "eligibleKeywordCount": 0,
      "refreshedKeywordCount": 0,
      "failedKeywordCount": 0,
      "skippedCountries": []
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

Documented for completeness. **Do not schedule these.**

## `GET /api/apps`

Lists tracked apps, and refreshes any owned app whose doc is older than 24h
against Apple as a side effect.

`?country=GB` — required.

```json
{ "success": true, "data": [ { "id": "6692632196", "kind": "owned", "name": "Chunks Microlearning", "averageUserRating": 5, "userRatingCount": 4, "previousAverageUserRating": 5, "previousUserRatingCount": 4, "icon": {}, "expiresAt": null, "lastFetchedAt": null, "lastKeywordAddedAt": "2026-07-27T21:51:08.694Z" } ] }
```

`kind` is `owned` or `research` — research entries are keyword scratchpads, not
real apps, and have no ranking columns.

## `GET /api/aso/top-apps`

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

Metadata for specific app ids. `?country=` `&ids=` (comma-separated; there is no
cap, they are fetched in batches of 50) `&refresh=1` to force a live lookup. Without `refresh`, only missing or
expired docs are fetched — so it is *usually* cheap, but not guaranteed.

## `GET /api/aso/apps/search`

Free-text App Store search. `?country=` `&term=` `&limit=` (default 20, max 50).
Always performs a live search.

---

# Mutating endpoints

| Route | Body | Notes |
|---|---|---|
| `POST /api/apps` | `{"type":"app","appId":"123","country":"GB"}` or `{"type":"research","name":"..."}` | Adds a tracked app; hydrates from Apple |
| `DELETE /api/apps` | `{"appId":"123"}` | Removes the app and its keyword associations |
| `POST /api/aso/keywords` | `{"appId":"123","keywords":["a","b"],"country":"GB"}` | **Crawls Apple synchronously.** Max 100 per call. Returns `{cachedCount, pendingCount, failedCount}`. Can exceed Cloudflare's 100s limit — use the internal URL for large batches |
| `DELETE /api/aso/keywords` | `{"appId":"123","keywords":["a"],"country":"GB"}` | `{removedCount}` |
| `POST /api/aso/keywords/favorite` | `{"appId":"123","keyword":"a","isFavorite":true,"country":"GB"}` | 404 if not tracked |
| `POST /api/aso/keywords/retry-failed` | `{"appId":"123","country":"GB"}` | Re-crawls failed keywords |
| `POST /api/aso/refresh/start` \| `/stop` | — | Manual crawl control; 202. The scheduler makes this unnecessary |
| `POST /api/aso/auth/start` \| `/respond` | see below | **Never call from automation** |
| `POST /api/aso/setup/start` \| `/respond` | | Primary App ID selection |

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

`docs/n8n-daily-report.json` implements this; it runs at 06:30, after the 04:00
crawl.

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
  A blocked storefront recovers by itself after a while. The scheduler paces
  itself; ad-hoc calls to the fetch-triggering endpoints do not.
- **One instance only.** SQLite is single-writer.
- **`AUTH_REQUIRED` is ambiguous** — bad API token or dead Apple session. Probe
  `/health` first.
- **Popularity does not vary by storefront.** Reporting it per country implies
  precision that is not there.
