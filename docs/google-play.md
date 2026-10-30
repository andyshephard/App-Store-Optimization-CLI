# Google Play keyword tracking

asocli tracks keywords on Google Play with its own fetchers. It uses no
DataForSEO and no third-party API: it reads the same public pages a browser
does, paced by the same per-host limiter as the App Store crawl.

Code: `cli/services/play/` (fetchers, parsers, difficulty, crawl),
`cli/db/play-keywords.ts` (storage), `cli/dashboard-server/routes/play-keyword-handlers.ts`
(API), `cli/commands/play-commands.ts` (CLI).

## What is measured

Per keyword and country:

| Field | Source | Notes |
|---|---|---|
| `rank` | Search page | Position of the app in the results, 1–30. `null` = not in the results Play shows. |
| `resultCount` / `appCount` | Search page | How many results Play listed (at most 30). |
| `rankDepth` | Search page | How deep the ranking was checked: equal to `resultCount`, which is the whole list. |
| `orderedAppIds` | Search page | Package names in rank order. |
| `topApps` | Search page | Title, developer, category, install band, rating and icon URL per result (API: `includeTopApps=1`). Icons are kept from 30 Oct 2026 on. |
| `competitorRanks` | Search page | Rank of each competitor package (see [Competitors](#competitors), plus `competitors=` on the request); `null` = not in the top 30. |
| `difficultyScore` | Top 10 results | 5–100, model `play-installs-v1` (below). |
| `autocompleteLetters` / `autocompleteRank` | Play search suggestions | Fewest letters typed (from 2) before Play suggests the exact term, and its position (1–5). `null` = never suggested. |
| `popularity` | — | Always `null`: Play publishes no search volume or popularity score. |

### Limits

- **Top 30 only.** Play's search page shows at most 30 results and has no next
  page. A keyword where the app is not in those 30 is "not ranked", with
  `rankDepth` saying how far was checked. Short lists (e.g. 11 results for
  "audio stories") are the whole result set, not a parse failure.
- **Popularity is an estimate from autocomplete, not a volume.** asocli stores
  the raw autocomplete letters and position; it does not turn them into a 0–100
  score (it does not for the App Store either). The middleware's App Store rule
  (`30 − 3 × letters` when suggested within 5 letters, `asoSnapshotSync.js`)
  can be applied to Play the same way.
- **Difficulty is not calibrated.** The App Store model was fitted to Astro's
  scores; there is no Play reference to fit to. Compare Play keywords with each
  other, not with App Store difficulty.
- **English-language countries only** (US, GB, AU, CA, NZ, IE). Install bands
  and title matching assume English text.
- Rank and difficulty are per country; autocomplete is per country too
  (`gl`/`hl` on the request).

## How it is fetched

**Search:** `GET https://play.google.com/store/search?q=<term>&c=apps&hl=en&gl=<CC>`
with a desktop Chrome user agent and `Accept-Language`. The page is
server-rendered; its data sits in `AF_initDataCallback({key: 'ds:N', ..., data: <json>})`
blocks. The results block (`ds:4`) holds `data[0][1]`, a list of sections:

- **Organic list:** `section[22][0]`, one item per result; the app is `item[0]`
  with package `[0][0]`, title `[3]`, rating `[4][1]`, category `[5]`, price
  `[8]`, developer `[14]`, install band `[15]`. Its `section[3]` token (base64)
  names the cluster `search_results_cluster_apps_range_<from>_<to>`, which the
  parser checks against the item count.
- **Top-result card** (seen for "stoic", "great people", "history timeline",
  "storytelling"): a section with an app-details record at `section[23][16][2]`,
  followed by the organic list as `range_1_<to>`. The card is rank 1. This is
  why a fixed `data[0][1][0][22][0]` path returned 0 results for those terms in
  the spike.
- **No results:** a `zero_results_cluster` section and no list.

An app list without a range label (a "similar apps" style cluster) is left out
of the ranking only when the labelled ranking already has all 30 results.
Anything else is a **contract failure**: a top card not followed by a labelled
list (`top_card_without_list`), an unlabelled list after a ranking shorter
than 30 (`cluster_after_short_ranking`), a page with only unlabelled lists, a
range that disagrees with its items, a top card after other results, or a page
with no result sections. Such a page: `PlayContractError`
(`PLAY_CONTRACT_CHANGED`), logged and reported like
`reportAppleContractChange` (`reportPlayContractChange`, deduplicated hourly),
recorded as the keyword's failure, and no ranks are written. Fixtures for each
layout are in `cli/services/play/__fixtures__/`.

**Autocomplete:** `POST https://play.google.com/_/PlayStoreUi/data/batchexecute?rpcids=IJ4APc&hl=en&gl=<CC>`
with form body `f.req=[[["IJ4APc","[[null,[\"<prefix>\"],[10],[2],4]]"]]]`. The
`[["wrb.fr","IJ4APc","<json>"...` line holds the payload; suggestions are at
`[0][0][i][0]`. A prefix with no suggestions answers `[[null, ...]]`, which is
an empty list, not an error; batchexecute's error envelope (null payload, error
code at `[5]`) is a contract failure (`suggest_rpc_error`), so a failed call is
never stored as "never suggested". The letters measure is the App Store one
(`measureAutocomplete`) reused as is, with prefixes shared between keywords.

**Difficulty (`play-installs-v1`, `play-difficulty.ts`):** each top-10 app's
strength = reach × quality × relevance, where reach is the install band on a log
scale (100 → 0, 100M+ → 1), quality is the rating (0.8 unrated or ≤ 3.5 → 1.0 at
5.0), and relevance is the title match (1.0 exact phrase, 0.85 all words, 0.7
none). Strengths are sorted strongest first and weighted with the App Store
ratings-mode weights; empty slots count as 0. Result: 5–100.

## Rate limits

Every Play request goes through `shared/apple-rate-limiter.ts` (now covering
Play as two host classes), with the same AIMD guard: a 429 or 503 halves the
rate for 30 minutes, then it recovers towards the cap. A 403 is not treated as
a throttle on Play. Requests and errors per host appear in
`lastRun.requests.byHost` and the health report's `rateLimits`.

| Host class | Endpoint | Env var | Default |
|---|---|---|---|
| `playsearch` | `play.google.com/store/search` | `ASO_RATE_PLAYSEARCH_PER_MIN` | 20 |
| `playsuggest` | `play.google.com/_/PlayStoreUi/data/batchexecute` | `ASO_RATE_PLAYSUGGEST_PER_MIN` | 30 |

Retries and timeouts follow `ASO_RETRY_*` (transient statuses and network
errors; 20 s search / 15 s suggest timeout).

## Nightly refresh

The background refresh crawls Play **after** every App Store storefront has
finished, in the same run, so it never delays or slows the App Store crawl.

- Runs only when `ASO_PLAY_APP_ID` is set, `ASO_PLAY_REFRESH` is not `0` and at
  least one Play keyword is tracked; countries from `ASO_PLAY_COUNTRIES`.
- The run's status, `finishedAt` and `requests` (per-host counts and rates) are
  fixed when the App Store crawl ends, before Play starts, so they describe the
  App Store crawl only. The Play phase keeps its own `startedAt`, `finishedAt`,
  `durationMs` and `requests` (Play hosts only) in `counters.play`. A stop
  during the Play phase sets `counters.play.stopped`; the run stays
  `completed`.
- Capped at `ASO_PLAY_PHASE_MAX_MINUTES` (default 30): no new keyword starts
  after that (`counters.play.timedOut`), the rest go first next run.
- If an ad-hoc Play crawl (keywords just added, a Play-only manual refresh) is
  still running, the phase waits up to 10 minutes for it, then records
  `counters.play.skipped = "already-running"`.
- Scheduled runs are forced (every keyword re-crawled daily); manual runs
  without `force` skip keywords crawled within `ASO_KEYWORD_ORDER_TTL_HOURS`.
- Least recently crawled first, so a stopped run resumes where it stopped.
- Failures are per keyword and soft: recorded in `play_keyword_failures`, the
  stored observation kept. Ten failures in a row abandon that country for the
  run. Nothing from the Play phase changes the run's status or `lastError`; a
  failure of the whole phase is kept in `counters.play.error`.
- Autocomplete: like the App Store check, each run re-measures about a seventh
  of a country's keywords (oldest first), so each is checked weekly. Keywords
  added without `defer` are measured at once; **deferred adds (the seed
  script) get their autocomplete over about a week**, roughly a seventh per
  night, so `autocompleteLetters` stays `null` for most of them until then.
- Run accounting: `counters.play` on `GET /api/aso/refresh-status` and on the
  run row (health `lastRun.play`): per country eligible / refreshed / failed /
  skipped / abandoned / failure reasons / autocomplete checked.
- A stop request stops the Play phase too, and a stopped App Store run skips it.

Cost: about one search request per keyword and country per night (≈ 200 for
~100 keywords in US and GB, ~10 minutes at 20/min) plus ~15 keywords' worth of
autocomplete prefixes per country.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ASO_PLAY_APP_ID` | unset | Package tracked by default, e.g. `com.andyshephard.chunks`. API and CLI fall back to it when no `appId` is given. Also the switch for Play in the nightly refresh and in reports: unset, the refresh skips Play and `playsearch`/`playsuggest` are left out of `requests.byHost`, `rates`, health `rateLimits`, and `lastRun.play` is omitted. |
| `ASO_PLAY_COUNTRIES` | `US,GB` | Play countries crawled and accepted. Add `AU`, `CA`, `NZ`, `IE`. Independent of `ASO_SUPPORTED_COUNTRIES`. |
| `ASO_PLAY_ROSTER_APP_IDS` | unset | Comma-separated competitor packages, fixed by the deployment (not removable from the dashboard). Added to the ones stored from the dashboard/API; see [Competitors](#competitors). |
| `ASO_PLAY_REFRESH` | on | `0` leaves Play out of the background refresh. |
| `ASO_PLAY_PHASE_MAX_MINUTES` | 30 | Time cap for the refresh's Play phase. |
| `ASO_RATE_PLAYSEARCH_PER_MIN` | 20 | See Rate limits. |
| `ASO_RATE_PLAYSUGGEST_PER_MIN` | 30 | See Rate limits. |

With `ASO_PLAY_APP_ID` unset, every response shape is unchanged.

Package names (`appId`, `competitors`) must look like package names (400
`INVALID_REQUEST` otherwise), and keywords are at most 100 characters.

## API

All on the existing endpoints; add `platform=android` (query string, or
`"platform": "android"` in a JSON body). Without it, or with `platform=ios`,
every endpoint behaves and responds exactly as before. Any other value is a 400.
Play countries are validated against `ASO_PLAY_COUNTRIES` (400
`COUNTRY_NOT_ENABLED`).

### `GET /api/aso/keywords?platform=android&country=US&appId=com.andyshephard.chunks`

`appId` defaults to `ASO_PLAY_APP_ID`. Paging and envelope as for the App Store
(`page`, `pageSize` ≤ 500, `keyword` filter; `sortBy` = `keyword` | `rank` |
`difficulty` | `autocomplete` | `updatedAt`, `sortDir`). Also `includeTopApps=1`
and `competitors=pkg1,pkg2`.

```json
{ "success": true, "data": {
  "platform": "android",
  "items": [ {
    "platform": "android", "keyword": "microlearning", "normalizedKeyword": "microlearning",
    "country": "US", "appId": "com.andyshephard.chunks",
    "popularity": null, "autocompleteLetters": 6, "autocompleteRank": 3, "autocompleteCheckedAt": "…",
    "difficultyScore": 36, "difficultyModelVersion": "play-installs-v1",
    "isBrandKeyword": null, "appCount": 30, "resultCount": 30, "rankDepth": 30, "layout": "list",
    "rank": 6, "previousRank": 7, "rankChange": -1,
    "orderedAppIds": ["com.app.smartyme", "…"],
    "competitorRanks": { "com.app.smartyme": 1 },
    "isFavorite": false, "addedAt": "…", "updatedAt": "…",
    "keywordStatus": "ok", "failure": null,
    "positions": [ { "appId": "com.andyshephard.chunks", "previousPosition": 7, "currentPosition": 6 } ]
  } ],
  "page": 1, "pageSize": 100, "totalCount": 99, "totalPages": 1,
  "hasPrevPage": false, "hasNextPage": false,
  "associatedCount": 99, "failedCount": 0, "pendingCount": 0
} }
```

The fields the middleware's `syncAsoSnapshots` reads for the App Store
(`keyword`, `popularity`, `difficultyScore`, `appCount`, `country`,
`isBrandKeyword`, `orderedAppIds`, and the rank as the app's index in
`orderedAppIds` + 1) are all present with the same meaning; `rank` is also given
directly. `keywordStatus` is `pending` until the first crawl, `failed` with a
`failure` (`stage: "search"`, `reasonCode` e.g. `HTTP_429`,
`PLAY_CONTRACT_CHANGED`) after a failed one — the last good data is kept.

### Other endpoints

| Endpoint | With `platform=android` |
|---|---|
| `POST /api/aso/keywords` | Body `{ platform, appId?, country, keywords, defer? }`. Tracks the keywords; unless `defer: true`, crawls the new ones in the background. `201 { platform, country, appId, addedCount, pendingCount, cachedCount: 0, failedCount: 0, deferred, refreshStarted }`. |
| `DELETE /api/aso/keywords` | Body `{ platform, appId?, country, keywords }` → `{ platform, removedCount }`. Stored observations are kept. |
| `GET /api/aso/position-history` | Daily rank per app/keyword/country from `play_keyword_position_history` (`since`, `appIds`, `limit` ≤ 5000, `offset`). Tracked apps get a point every crawl (`null` = outside the top 30); roster apps where they rank. |
| `GET /api/aso/autocomplete` | `{ platform, country, running, items: [ { keyword, lettersNeeded, hintRank, checkedAt } ] }`. |
| `POST /api/aso/autocomplete/refresh` | Re-measures the due seventh for `country` (202). |
| `POST /api/aso/refresh/start` | Play-only crawl in the background (`force=1` to ignore freshness). |
| `GET /api/aso/storefronts` | (no parameter) now also returns `playCountries`. |

`GET /api/aso/refresh-status` carries `counters.play` for the current or last
run; `GET /api/aso/health` carries `lastRun.play` (informational: Play never
changes the health status).

## Suggestions

The autocomplete check asks Play's suggestions for the prefixes of our tracked
keywords ("mi", "mic", … until the keyword shows up). Every answer is kept in
`play_keyword_suggestions` (schema v6), so the terms Play suggests can be
offered as new keyword ideas (the middleware's Play gems) **without any extra
request**: the same prefixes, asked by the same check, at the same pace.

- Kept per country, prefix and suggested term: its position (1–5), the
  tracked keyword (seed) whose check asked the prefix, and when it was first
  and last seen. Each answer replaces the prefix's earlier one, so a term that
  dropped out of a prefix's list is gone from that prefix.
- The check re-measures about a seventh of the keywords each night, so the
  whole set of prefixes is re-asked about once a week. A keyword suggested at
  2 letters asks one prefix; one never suggested asks up to 20.
- Storing never fails or changes the check: an error is logged and counted as
  nothing stored. `counters.play.countries[].suggestionsStored` says how many
  were kept in a run.
- Rows not seen for 90 days are pruned by the nightly refresh.

### `GET /api/aso/play-suggestions?country=US`

One item per suggested term seen in the last `days` (default 14, 1–90),
leaving out terms tracked on Play in that country (any app) unless
`includeTracked=1`. Its own path, no `platform` parameter:
`/api/aso/suggestions` is the App Store's Apple Ads keyword ideas, unchanged.
The read token may call it (a database read only).

```json
{ "success": true, "data": {
  "platform": "android", "country": "US", "days": 14, "since": "…", "totalCount": 120,
  "items": [ {
    "keyword": "micro learning courses", "country": "US",
    "prefix": "micro", "letters": 5, "position": 2, "seed": "microlearning",
    "prefixCount": 3, "firstSeenAt": "…", "lastSeenAt": "…", "tracked": false
  } ]
} }
```

`prefix`, `letters` and `position` are the term's shortest prefix and its
position there (best position on a tie); `letters` counts the prefix's
characters, as `autocompleteLetters` does. `seed` is the tracked keyword whose
check asked that prefix, `prefixCount` how many asked prefixes suggested the
term. `firstSeenAt` is the start of its current run of sightings: a term that
drops out of a prefix's list and comes back starts again. Ordered by letters, then position. The terms are raw: other apps' names
and unrelated words are common (prefix "mi" suggests "minecraft"); the
middleware filters them.

## Competitors

Competitors are the Play counterpart of the App Store's competitor apps: their
rank is read for **our** tracked keywords (`ASO_PLAY_APP_ID`'s), from the same
search page, so tracking one costs no request.

The roster is `ASO_PLAY_ROSTER_APP_IDS` plus the packages in the
`play_competitor_apps` table (schema v5), which the dashboard and the API add
and remove. Our own package is never on it. With both, either works; the
environment ones cannot be removed from the dashboard.

- `GET /api/apps?platform=android` → `{ platform, items: [ { id, name,
  developer, iconUrl, kind: "owned" | "competitor", source: "ASO_PLAY_APP_ID" |
  "ASO_PLAY_ROSTER_APP_IDS" | "dashboard", removable, addedAt } ] }`, our app
  first. `name`, `developer` and `iconUrl` come from the newest stored search
  result that lists the package (any keyword, any country): `null` until it has
  appeared in a crawled top 30. No Play request is made for them.
- `POST /api/apps` `{ "platform": "android", "appId": "com.example.app" }` →
  `201 { platform, id, name, added }` (`added: false` when it was already on
  the roster). 400 `INVALID_REQUEST` for anything but a package name (`PACKAGE_ID`,
  at most 200 characters), for our own package, or past 50 competitors.
- `DELETE /api/apps` `{ "platform": "android", "appId": … }` → `200 { platform, id }`;
  400 for a package from the environment, 404 for one not tracked. History is kept.

What a competitor gets:

- **Ranks at once:** `competitorRanks` on `GET /api/aso/keywords?platform=android`
  is computed from each keyword's stored `orderedAppIds`, so a new competitor's
  ranks show up from the last crawl.
- **History from the next crawl:** each crawl writes a
  `play_keyword_position_history` point for a competitor where it ranks (none
  where it does not; our app gets a `null` there). The dashboard's chart counts a
  day our app was crawled without a point for the competitor as outside the
  top 30, from the day it was added (from the start of the window for
  environment ones).
- **No change column:** the previous position is kept for our app only.

## Dashboard

When `ASO_PLAY_APP_ID` is set (`playAppId` on `GET /api/aso/storefronts`), the
sidebar header has a store toggle: **App Store | Google Play | Both**,
remembered per browser. Without it the dashboard is the App Store one,
unchanged.

- **Google Play apps** (sidebar, Google Play and Both): our app and the
  competitors, with name and icon from search results (initials until a
  package has shown up in a top 30). Add a competitor by package name at the
  bottom of the list; × removes one added there. Selecting a competitor shows
  its rank per keyword ("Not in top 30" otherwise) and its rank history; the
  App Store app list is hidden on the Google Play view and stays on Both.
- **Competitors column** (Google Play and Both; checkbox in the toolbar,
  remembered per browser): for each keyword, the other tracked apps in its top
  30 with their rank, best first, e.g. "Paladin 3 · Nibble 7" (title up to its
  first ":" or " - "). With a competitor selected, our app is one of them.
- **Google Play**: the tracked keywords for `ASO_PLAY_APP_ID` in a country from
  `playCountries` - rank ("Not in top 30" when outside the list), change,
  popularity as autocomplete letters and suggestion position, difficulty,
  result layout and count, last updated, and the search failure code. Add
  keywords with the form at the top; remove one with its row's × or the
  right-click menu. Rank opens a 90-day chart from `position-history`
  (`platform=android`); a day outside the top 30 is a gap in the line.
- **Both**: one row per keyword (case and whitespace ignored) across both
  stores for a country enabled on both, with App Store popularity and rank
  (for the App Store app selected in the sidebar) beside Play popularity and
  rank (for the selected Google Play app), all sortable. A keyword tracked on one store only offers "Track on <store>":
  App Store adds are deferred (`defer: true`, no Apple session needed; data
  arrives with the next refresh), Play adds are crawled at once.

The views read every row (pages of 500) and sort in the browser. Code:
`cli/dashboard-ui/store-merge.ts` (merge, sort, competitor placements),
`components/play-keywords-view.tsx`, `components/both-stores-view.tsx`,
`components/play-apps-list.tsx`, `hooks/use-play-apps.ts`;
`cli/db/play-competitors.ts` on the server.

## CLI and MCP

```bash
# Live crawl (search + autocomplete), stored and associated with the app; JSON envelope like the App Store path.
aso keywords "microlearning,chunks" --platform android --country US --app-id com.andyshephard.chunks --stdout

# Track / untrack without crawling (the nightly refresh picks them up). Works for --platform ios too.
aso track --platform android --file scripts/play/chunks-play-keywords.txt --country US,GB --app-id com.andyshephard.chunks
aso untrack "old term" --platform android --country US,GB --app-id com.andyshephard.chunks
```

The MCP tool `aso_evaluate_keywords` takes `platform: "android"` (and an
optional `country`); Play items are filtered by `maxDifficulty`, `appId` and
`excludeExisting` apply, and they carry `autocompleteLetters`,
`autocompleteRank`, `rank` and `appCount`. `minPopularity` does not apply (no
Play popularity); when it is passed the result says it was ignored.

## Seeding Chunks

`scripts/play/chunks-play-keywords.txt` holds the 99 Chunks terms (the spike's
94 plus the microlearning and brand terms). On a hosted asocli:

```bash
ASO_BASE_URL=https://keywords.chunks.app ASO_API_TOKEN=… \
  scripts/play/seed-play-keywords.sh scripts/play/chunks-play-keywords.txt US,GB com.andyshephard.chunks
```

That posts with `defer: true`, so nothing is crawled until the next nightly
refresh, and autocomplete fills in over about a week (see Nightly refresh). The
token is passed to curl as a config file on stdin, never on its command line. Locally, use `aso track` as above.

The 13 competitors from the middleware's roster are in
`scripts/play/chunks-play-competitors.txt` (Deepstash, Duolingo, Imprint, Khan
Academy, NerdSip, Nibble, Paladin, Yuno, Nerdish, Headway, Blinkist, Elevate,
Brilliant):

```bash
ASO_BASE_URL=https://keywords.chunks.app ASO_API_TOKEN=… \
  scripts/play/seed-play-competitors.sh scripts/play/chunks-play-competitors.txt
```

One `POST /api/apps` per package, no Play request; re-running is harmless.
They then appear in the dashboard and can be removed there. The same script
works against a local dashboard (`ASO_BASE_URL` defaults to
`http://127.0.0.1:3456`). Alternatively, set `ASO_PLAY_ROSTER_APP_IDS` to the
packages (comma-separated) and restart; those cannot be removed from the
dashboard.

## Storage

Schema version 4 adds five tables and changes none of the existing ones
(`docs/aso-local-sqlite-schema.md`): `play_app_keywords` (associations),
`play_keywords` (latest observation per country/keyword), `play_keyword_autocomplete`,
`play_keyword_failures` (per stage: `search` / `autocomplete`) and
`play_keyword_position_history` (730 days kept). The migration runs once on
open; rolling back to an older build leaves the tables unused. Schema version 5
adds `play_competitor_apps` (package, `added_at`) the same way, and version 6
adds `play_keyword_suggestions` (see [Suggestions](#suggestions)), also
without changing an existing table.

## Validation

A spike on 2026-10-30 crawled the Chunks terms in US and GB with these requests
and compared the ranks with DataForSEO's Google Play SERP API for the same
moment: **10 of 10 terms matched exactly** — same rank for Chunks and the same
top 10 — at a DataForSEO cost of $0.03. The spike's fixed path
(`data[0][1][0][22][0]`) returned 0 results wherever Play shows a top-result
card ("stoic", "great people", "history timeline", "storytelling"); the
section-based parser here reads those (the card is rank 1). The 10–13 results
it found for "audio stories", "biography" and "marcus aurelius" were plain short
lists when re-fetched in the US (`range_0_11` etc.): Play lists only that many. A live check of
this implementation from a workstation the same day gave, in the US: chunks 1,
microlearning 6, bite sized learning 8, free microlearning 10, micro learning 11.
