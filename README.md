<h1 align="center">App Store Optimization CLI</h1>

<p align="center">
  <img src="./assets/app-icon/aso-icon-readme.png" alt="ASO icon" width="132" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/aso-cli"><img src="https://img.shields.io/npm/v/aso-cli" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/aso-cli"><img src="https://img.shields.io/node/v/aso-cli" alt="Node.js" /></a>
  <a href="https://github.com/semihcihan/App-Store-Optimization-CLI/actions/workflows/ci.yml"><img src="https://github.com/semihcihan/App-Store-Optimization-CLI/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
</p>

Research ASO keywords, inspect competition, and manage results from one local-first CLI.

## What Is It?

- Fast, free keyword research and visibility tracking
- Keyword scoring with popularity + difficulty + brand classification in one command
- Local ASO dashboard for reviewing keyword/app data
- MCP tool (`aso_evaluate_keywords`) for agent workflows and automated keyword research

<h3 align="center">ASO Dashboard</h3>

<p align="center">
  <img src="./cli/dashboard-ui/public/dashboard.jpg" alt="ASO dashboard" title="ASO Dashboard" width="900" />
</p>

<h3 align="center">MCP</h3>

The dashboard keywords shown above were discovered and added automatically by an agent using the MCP tool.

<p align="center">
  <img src="./cli/dashboard-ui/public/mcp.jpg" alt="ASO MCP workflow" width="900" />
</p>

## Install

```bash
npm install -g aso-cli
```

Note: requires Node.js `>=18.14.1`.

## Apple Search Ads Setup

ASO commands require Apple Search Ads setup.

### Prerequisites

- App Store Connect account
- App ID of a published app you can access
- No campaign creation required
- No billing information required

### Setup

1. Create/sign in: https://searchads.apple.com
   - If your country is not available during signup, select `United States`.
2. Open Apple Search Ads Advanced: https://searchads.apple.com/advanced
3. Click your account name in the top-left corner.
4. Under Campaign Groups, click Settings.
5. Click Link Accounts.
6. Select your App Store Connect account and save.
   - If this is your first time using Apple Search Ads, you will usually have only one campaign group.
7. Copy an App ID from your App Store URL (number after `id`)
   Example App Store URL:
   ```text
   https://apps.apple.com/us/app/example-app/id123456789
   ```
   App ID is `123456789` in this example.
8. Run `aso auth` and complete Apple ID + password + 2FA in terminal

Notes:

- You may see a missing billing information warning; this can be safely ignored.
- Ensure all campaign groups are linked to a valid App Store Connect account.
- [Troubleshoot App Store Connect account linking](https://ads.apple.com/app-store/help/get-started/0012-link-app-store-connect-accounts)

## Quick Start

```bash
# Authenticate once
aso auth

# Fetch keyword metrics
aso keywords "meditation,sleep sounds,white noise"

# Open dashboard
aso
```

## Command Reference

| Command                         | What it does                                            |
| ------------------------------- | ------------------------------------------------------- |
| `aso`                           | Starts the local dashboard (default command)            |
| `aso keywords "k1,k2,k3"`       | Fetches keyword popularity/difficulty and prints JSON   |
| `aso keywords "k1,k2" --stdout` | Machine-readable mode for automation/agents              |
| `aso auth`                      | Reauthenticates Apple Search Ads session                |
| `aso reset-credentials`         | Clears saved credentials/cookies                        |
| `aso --primary-app-id <id>`     | Sets primary App ID used for popularity requests        |

### Supported flags

- `--country <code>`: any storefront listed in `ASO_SUPPORTED_COUNTRIES` (default `US`)
- `--primary-app-id <id>`: saved locally for future runs
- `--min-popularity <number>`: filters out low-popularity keywords before enrichment
- `--max-difficulty <number>`: filters out high-difficulty keywords after enrichment
- `--app-id <id>`: associates keywords to this local app id (default: `research`)
- `--exclude-existing`: skips keywords already associated with the target app/country before evaluation
- `--no-associate`: skips app-keyword association writes for the current `aso keywords` run

Association behavior for `aso keywords`:
- Association writes happen only after a successful command return.
- Without filters, requested keywords are associated.
- With `--min-popularity` and/or `--max-difficulty`, only accepted `items` are associated.
- With `--exclude-existing`, already associated keywords are returned in `filteredOut` with `reason="already_associated"` and are not re-associated.
- With `--no-associate`, no association write occurs.

## Output Example (`aso keywords "meditation"`)

````json
{
  "items": [
    {
      "keyword": "meditation",
      "popularity": 45,
      "difficultyScore": 62,
      "minDifficultyScore": 38,
      "isBrandKeyword": false
    }
  ],
  "failedKeywords": [],
  "filteredOut": []
}
````

## `--stdout` Contract

`aso keywords "<comma-separated-keywords>" --stdout` is the machine-readable contract.

- Success: exit code `0`, `stdout` contains exactly one JSON object with:
  - `items`
  - `failedKeywords`
  - `filteredOut`
- Failure: exit code `!= 0`, `stdout` contains exactly one JSON object with:
  - `error.code` (`CLI_VALIDATION_ERROR` or `CLI_RUNTIME_ERROR`)
  - `error.message`
  - optional `error.help`
- In `--stdout` mode, CLI logs and prompts are kept off `stdout` so parsers can read one JSON payload safely.

Failure example:

````json
{
  "error": {
    "code": "CLI_RUNTIME_ERROR",
    "message": "Primary App ID is missing. Run 'aso --primary-app-id <id>' or run 'aso' in a terminal to set it, then retry this command with --stdout."
  }
}
````

## MCP

This package also installs `aso-mcp` with tool: `aso_evaluate_keywords`.

`aso_evaluate_keywords` runs `aso keywords ... --stdout` with default filters:
- `minPopularity = 6` when omitted; accepts explicit values from `0` to `100`
- `maxDifficulty = 70`
- `excludeExisting = false`; set `true` to return only keywords not already associated with the target app/country

MCP returns only accepted rows (`keyword`, `popularity`, `difficulty`, `minDifficultyScore`, `isBrandKeyword`).

Example MCP config:

```json
{
  "mcpServers": {
    "aso": {
      "command": "aso-mcp"
    }
  }
}
```

## Storefronts

Storefronts are opt-in through `ASO_SUPPORTED_COUNTRIES` (comma-separated). With
it unset only `US` is enabled, which is the original behaviour.

```bash
ASO_SUPPORTED_COUNTRIES=US,GB aso keywords "wikipedia" --country GB
ASO_SUPPORTED_COUNTRIES=US,GB,CA,AU,IE,NZ,DE,FR,ES,IT,PT aso   # dashboard picker
```

Known storefronts live in `cli/shared/aso-storefronts.ts`: US, GB, CA, AU, IE,
NZ, DE, FR, IT, ES, PT. Each entry carries the storefront id and its language
index; both are needed for Apple's `X-Apple-Store-Front` header, and the
language index is per storefront (US 1; GB/AU/IE/NZ 2; FR 3; DE 4; CA 6; IT 7;
ES 8; PT 24). Index 2 returns HTTP 200 on every storefront but with English
metadata, so a 200 does not mean the index is right — follow the probe recipe in
that file before adding another.

`defaultLanguage` is used as the `?l=` parameter when fetching an app page, and
the English locales are not interchangeable: `?l=en-AU` and `?l=en-GB` return
different titles for the same app.

What is and is not per storefront:

- Per storefront: rank, `app_count`, `difficulty_score`, `keyword_match`,
  `is_brand_keyword`. These are computed from that storefront's search page.
- Account-level: `popularity`. Apple returns the same score regardless of
  storefront, so the same number appears under every storefront.

The dashboard shows a storefront picker when more than one is enabled; data
routes reject a storefront that is not enabled with `COUNTRY_NOT_ENABLED`.

Rating counts on the search page are localized strings, not numbers, and the
formats differ per storefront (`6.2K` in US, `428.932` in DE, `6,8 mil` in ES,
`8,4 k` in FR). `cli/shared/aso-rating-count.ts` parses them per locale; it
feeds `appCompetitiveScore` and therefore `difficulty_score`, so add a sample
there when onboarding a storefront with a new number format.

Keyword-match detection still splits on spaces, so it suits Latin-script
storefronts. CJK storefronts would need a different tokenizer.

## Hosting

The dashboard and its API can run on a server behind TLS, with a bearer token
required on every request. See [docs/deployment.md](docs/deployment.md) for the
Docker Compose + Caddy setup, including how Apple login and two-factor are
completed entirely in the browser with no terminal access.

Once hosted, the server refreshes itself on a schedule and
[docs/api.md](docs/api.md) documents every endpoint for automation — including
which ones are pure database reads and which reach out to Apple as a side effect
of a GET.

## Project Docs

- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Website architecture: [docs/website-architecture.md](docs/website-architecture.md)
