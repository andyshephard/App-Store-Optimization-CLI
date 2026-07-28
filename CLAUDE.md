# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A fork of [semihcihan/App-Store-Optimization-CLI](https://github.com/semihcihan/App-Store-Optimization-CLI)
(`aso-cli` v0.17.0, MIT), cloned at upstream `0671de3`. The fork exists to unlock
multi-storefront keyword tracking, which upstream scopes to US only. Nothing has
been committed yet — everything below is in the working tree.

Primary consumer: the **Chunks Microlearning** iOS app (`6692632196`), whose repo
is at `~/Documents/projects/chunks/chunks-frontend`. Its per-locale App Store
keyword fields live in `metadata/ios/<locale>/keywords.txt` there.

## Commands

```bash
npm run dev              # esbuild watch + Vite dashboard watch + CLI
npm run build            # esbuild -> cli/dist/cli.js
npm run dashboard:build  # Vite -> cli/dist/dashboard-public
npm test                 # jest (node + jsdom projects)
npm run typecheck        # tsc for cli and dashboard-ui
npm run ci               # typecheck + test + build

# Multi-storefront usage
ASO_SUPPORTED_COUNTRIES=US,GB,CA,AU,IE,NZ,DE,FR,ES,IT,PT aso
ASO_SUPPORTED_COUNTRIES=US,GB node cli/dist/cli.js keywords "wikipedia" --country GB --stdout
```

Single test:

```bash
npm test -- --watchman=false cli/services/keywords/aso-popularity-service.test.ts
npm test -- --watchman=false -t "returns partial success"
npm test -- --selectProjects node        # or jsdom
```

Jest runs two projects: `node` matches `cli/**/*.test.ts`, `jsdom` matches
`cli/**/*.test.tsx`. `*.integration.test.*` / `*.e2e.test.*` are excluded.
`npm run start:dev` writes `aso-debug.log` in cwd at debug level.
`npm run link:cli` builds and `npm link`s a global `aso`; MCP inspector is
`npm run mcp:test`. `website/` is a separate Astro package with its own lockfile
(`npm ci --prefix website`).

Node: `.npmrc` sets `engine-strict=true` and posthog-node wants
`^20.20.0 || >=22.22.0`. On Node 22.19 install with `--engine-strict=false`.
Runtime target is `>=18.14.1`; dev/build checks enforce `>=20.19.0`.

## Architecture

Three build outputs from one TypeScript tree:

| Entry | Output | Surface |
| --- | --- | --- |
| `cli/cli.ts` | `cli/dist/cli.js` (`aso`) | yargs CLI; default command starts dashboard |
| `cli/mcp/index.ts` | `cli/dist/mcp.js` (`aso-mcp`) | MCP server, tool `aso_evaluate_keywords` |
| `cli/dashboard-ui` (Vite) | `cli/dist/dashboard-public` | React SPA served by the dashboard HTTP server |

Layers, inner to outer:

- `cli/domain/` — pure policy shared by every surface (keyword normalization and
  limits, storefront gating, dashboard error codes). No IO.
- `cli/db/` — better-sqlite3. `store.ts` creates the schema and applies inline
  migrations on open; per-table modules wrap queries. DB at
  `~/.aso/aso-db.sqlite` (`ASO_DB_PATH` overrides), alongside `aso-cookies.json`
  and `config.json`.
- `cli/services/` — `keywords/` (pipeline + Search Ads popularity), `cache-api/`
  (App Store scraping, enrichment, difficulty), `auth/` (Apple ID login,
  cookies, Keychain), `sensortower/`, `runtime/`, `telemetry/`.
- `cli/shared/` — env parsing, HTTP, retry/resilience, storefront tables.
- Surfaces — `cli/commands/aso.ts`, `cli/dashboard-server/`, `cli/mcp/`.

### Single-owner rules (do not fork these)

- `cli/services/keywords/keyword-pipeline-service.ts` is the **only** keyword
  orchestration entrypoint — CLI fetch, dashboard add-keywords, retry-failed and
  startup refresh all go through it.
- `cli/services/keywords/keyword-write-repository.ts` is the **only** writer of
  keyword cache rows, failure rows, competitor app docs and previous positions.
- `cli/domain/errors/dashboard-errors.ts` is the single error-code mapping,
  consumed by both `dashboard-server/server.ts` and `dashboard-ui/app-helpers.ts`.
- `cli/cli.ts` is the only place that emits the `--stdout` failure envelope.
- Auth/setup prompts are emitted as structured requests by services; only the
  *transport* differs (terminal prompts vs dashboard prompt-session + browser
  modal). Never fork auth logic per surface.

### Keyword pipeline

Two stages with independent TTL caches: **popularity** (Search Ads,
account-level, `ASO_POPULARITY_CACHE_TTL_HOURS`) then **enrichment** (search page
→ difficulty, app count, ordered app ids, brand flag; order TTL
`ASO_KEYWORD_ORDER_TTL_HOURS`). A miss is classified into full-enrich /
popularity-only / order-only refresh. Partial success is normal: the envelope is
`{ items, failedKeywords, filteredOut }` and a run hard-fails only when every
keyword fails. Terminal per-keyword failures land in `aso_keyword_failures` and
drive the dashboard retry-failed flow.

### The `--stdout` contract

`aso keywords "..." --stdout` is a machine contract MCP depends on —
`cli/mcp/services/aso-evaluate-keywords.ts` shells out to the CLI binary and
parses exactly one JSON object from stdout. Anything else written to stdout in
that mode (logs, prompts, update notices) breaks MCP. Interactive auth is
disabled there: one silent reauth attempt, then a JSON failure envelope with
`error.code` = `CLI_VALIDATION_ERROR` or `CLI_RUNTIME_ERROR`.

### Dashboard server

Plain `node:http` (`dashboard-server/server.ts`), split into `auth-state.ts`,
`setup-state.ts`, `apps-handler.ts`, `routes/keyword-handlers.ts`,
`routes/app-doc-handlers.ts`, `http-utils.ts`, `static-files.ts`. Binds
`127.0.0.1:3456` by default with fallback to a free port; **no network auth**, so
non-loopback binds are trusted-network-only. JSON bodies capped at 1 MiB. Keyword
reads are server-side paginated/filtered/sorted; the client polls for background
enrichment progress.

### Generated and native

`cli/mcp/content/*.md` is the source of truth; `generate-mcp-content` (a
prebuild/pretest hook) compiles it into `cli/mcp/generated/*.ts` — never edit
`cli/mcp/generated/` or `cli/dist/` by hand. `better-sqlite3` is `external` in
both esbuild bundles; a new dependency with native or dynamic-require behavior
needs the `external` lists in `esbuild.config.js` updated.

### Behavior docs

`docs/aso-runtime-flows.md` holds per-flow contracts (CLI fetch, dashboard
add/retry/refresh, app-doc hydration, MCP, auth) — read before changing pipeline
or dashboard flow behavior. `docs/aso-error-handling.md` covers failure
boundaries, retry policy and telemetry redaction. Also
`docs/aso-local-sqlite-schema.md`, `docs/aso-keyword-fetch-design.md`,
`docs/apple-data-endpoints-matrix.md`. Update these and `README.md` when behavior
changes.

## Storefronts

`cli/shared/aso-storefronts.ts` is the single source of truth: US, GB, CA, AU,
IE, NZ, DE, FR, IT, ES, PT. Read the comment at the top of that file before
adding another — the important part is that the `X-Apple-Store-Front` header is
`<storefrontId>-<languageIndex>,<platformId>` and **the language index is per
storefront**, not a constant:

| US 1 | GB 2 | FR 3 | DE 4 | CA 6 | IT 7 | ES 8 | PT 24 | AU/IE/NZ 2 |

Index 2 returns HTTP 200 on *every* storefront but with **English** metadata, so
a 200 does not mean the index is right. Verify a candidate index by checking
`genreNames` comes back in the local language, against **two different apps**
(Wikipedia `324715238` and Chunks `6692632196` were used). Picking wrong does not
error — it silently returns another language's title/subtitle, which corrupts
keyword-match detection and therefore difficulty scores.

`defaultLanguage` becomes the `?l=` parameter on app pages, and the English
locales are **not** interchangeable: `?l=en-AU` and `?l=en-GB` return different
titles for the same app.

What is and is not per storefront:

- **Per storefront**: rank, `app_count`, `difficulty_score`, `keyword_match`,
  `is_brand_keyword` — all computed from that storefront's search page, whose
  storefront comes from the URL path (`/gb/iphone/search`), not the header.
- **Account-level**: `popularity`. Apple returns the same score for every
  storefront. Report it honestly rather than implying a per-country figure.

## Apple rate limiting

The app-detail endpoint throttles **per storefront and per client**, answering
403. Measured directly (2026-07-28, probing NZ from one machine):

- **~100–200 rapid requests to one storefront trips it.** A wave of 100 was
  clean; the next 100 returned 71 × 403.
- **Recovery is seconds, not minutes.** An app returning 403 three times in a row
  served 200 about a minute later. An earlier note here claimed blocks lasted
  ~30 minutes; that was wrong, and probably described retries re-tripping it.
- **It is per client, not global.** A workstation was 403 on US while the VPS
  crawled US concurrently with zero failures.

So the useful lever is requests-per-storefront in a short window, not total
elapsed time. Concurrency alone is not the trigger: 25 simultaneous requests
were fine, while 60 sequential ones during an active block all failed.

It surfaces as `INSUFFICIENT_DOCS` (503) with `docsForDifficulty=0`, which reads
like a data problem and hides the cause. Checking whether a storefront is
serving before spending calls on it is still the cheapest guard:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "X-Apple-Store-Front: 143443-4,29" -H 'Accept: application/json' \
  https://apps.apple.com/app/id324715238     # 200 = open, 403 = blocked
```

Known follow-ups, neither done:
1. Classify 403 on `appstore.app-lookup` as a throttle and back off, instead of
   reporting `INSUFFICIENT_DOCS`.
2. `additionalLanguages: ["en-GB"]` on DE/FR/ES/IT/PT doubles app-doc requests in
   those storefronts, which is what trips the block. CA carries `["fr-CA"]`
   deliberately (Apple serves real French metadata there).

## Rating counts are localized strings

Search-page `ratingCount` is pre-formatted per locale, not a number:
`6.2K` (US), `428.932` (DE — dot is a **thousands** separator), `6,8 mil` (ES),
`8,4 k` (FR, with a non-breaking space), `5,9K` (IT), `1,3 mil` (PT).

`cli/shared/aso-rating-count.ts` parses these per locale (separators from `Intl`,
suffixes from a per-language table). It feeds `appCompetitiveScore` and therefore
`difficulty_score`, so add a sample to its test when onboarding a storefront with
a new number format. An unknown suffix returns 0 rather than a number wrong by
three orders of magnitude.

`detectKeywordMatchType` splits on spaces, so it suits Latin-script storefronts.
CJK would need a different tokenizer — that is why JP/KR/HK/TW are not in the
table.

## Dashboard UI

- **Light is the default**, dark opt-in via `data-theme="dark"` on `<html>`
  (`cli/dashboard-ui/hooks/use-theme.ts`, persisted in localStorage).
- **The palette lives only in `cli/dashboard-ui/ui/theme.css`** (light + dark
  blocks). `styles.css` previously carried a second `:root` with a hardcoded dark
  palette that silently overrode it — that is gone. If a colour looks wrong in
  one theme, look for a hardcoded literal rather than adding an override; the
  sweep left exactly one intentional literal (`#16a34a`, onboarding green).
- Table column order: keyword, popularity, difficulty, rank, change, app count,
  favorite, added, updated, top apps. **Rank and change are hidden when a
  Research entry is selected** — a research entry is not an app, so it has no
  ranking. This is not a bug.
- Storefront picker appears only when more than one storefront is enabled, so a
  default install looks exactly like upstream.

## Telemetry

Upstream hardcodes its own PostHog project key, so every command by anyone lands
in the author's analytics. It is blanked in this fork (`instrument.ts`) —
telemetry is opt-in via `ASO_POSTHOG_API_KEY`. Bugsnag needed no change: its key
is a build-time placeholder only substituted when upstream publishes.

## Conventions

- Dashboard data routes reject a storefront that is not enabled with a 400
  (`COUNTRY_NOT_ENABLED`) rather than silently falling back to US — serving US
  data under a GB heading is worse than an error.
- With `ASO_SUPPORTED_COUNTRIES` unset, behaviour must stay byte-identical to
  upstream. That is the regression guard; check it before claiming a change is
  safe to offer back upstream.
- UI tests index table cells positionally (`getAllByRole("cell")[3]`), so adding
  or moving a column breaks them — expect to update `app.columns.test.tsx` and
  `app.interactions.test.tsx` together.
- macOS ships bash 3.2: no `declare -A` in helper scripts.
- Prettier (`.prettierrc.json`): 2 spaces, double quotes, semicolons, 80 cols,
  es5 trailing commas. Tests sit next to the code they cover.
