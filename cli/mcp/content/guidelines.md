## ASO MCP Guidelines

Use `aso_evaluate_keywords` to evaluate explicit ASO keyword candidates (US storefront only).

## Tool Input

- `keywords`: array of ASO search term candidates (single-word or long-tail phrases).
- `minPopularity` (optional): minimum popularity threshold.
- `maxDifficulty` (optional): maximum difficulty threshold.
- `appId` (optional): local app id for association (defaults to research app when omitted).
- `excludeExisting` (optional): when true, return only keywords not already associated with the target app/country.

## Behavior

- Keywords are normalized to lowercase, deduplicated, and invalid candidates are dropped.
- The tool runs `aso keywords <terms> --stdout --min-popularity ... --max-difficulty ...` under the hood.
- With `excludeExisting=true`, the tool also passes `--exclude-existing`; skipped keywords are handled by the CLI `filteredOut(already_associated)` contract.
- CLI `--stdout` contract is explicit:
  - success (`exitCode=0`): stdout JSON with `items`, `failedKeywords`, `filteredOut`
  - failure (`exitCode!=0`): stdout JSON error envelope with `error.code`, `error.message`, optional `error.help`
- MCP does not write directly to DB; keyword association is handled by the CLI command path.
- Output is a JSON array containing only accepted keywords with compact fields:
  - `keyword`
  - `popularity`
  - `difficulty`
  - `minDifficultyScore`
  - `isBrandKeyword`

## Auth Requirement

If machine-safe execution fails because interactive Apple Search Ads auth is required, the user must run:

```bash
aso auth
```

Then retry `aso_evaluate_keywords`.
