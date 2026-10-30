#!/usr/bin/env bash
# Track a keyword file on Google Play through a running asocli's API.
#
#   ASO_BASE_URL=https://keywords.chunks.app ASO_API_TOKEN=... \
#     scripts/play/seed-play-keywords.sh scripts/play/chunks-play-keywords.txt US,GB com.andyshephard.chunks
#
# One POST /api/aso/keywords per country and 100 keywords, with
# platform=android and defer=true: nothing is crawled now, the next nightly
# refresh picks the keywords up. Re-running is harmless (existing keywords are
# skipped). Lines starting with # are ignored. For a local database use the
# CLI instead: aso track --platform android --file <file> --country US,GB --app-id <package>
set -euo pipefail

FILE="${1:?usage: seed-play-keywords.sh <keywords-file> <countries, e.g. US,GB> [package]}"
COUNTRIES="${2:?usage: seed-play-keywords.sh <keywords-file> <countries, e.g. US,GB> [package]}"
APP_ID="${3:-${ASO_PLAY_APP_ID:-}}"
BASE_URL="${ASO_BASE_URL:-http://127.0.0.1:3456}"
BATCH=100

if [ -z "$APP_ID" ]; then
  echo "Pass the package as the third argument or set ASO_PLAY_APP_ID." >&2
  exit 1
fi

AUTH_ARGS=()
if [ -n "${ASO_API_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${ASO_API_TOKEN}")
fi

# Keywords, one per line, without comments or blanks.
KEYWORDS_FILE="$(mktemp)"
trap 'rm -f "$KEYWORDS_FILE"' EXIT
grep -v '^[[:space:]]*#' "$FILE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' > "$KEYWORDS_FILE"
TOTAL="$(wc -l < "$KEYWORDS_FILE" | tr -d ' ')"

for COUNTRY in $(echo "$COUNTRIES" | tr ',' ' '); do
  START=1
  while [ "$START" -le "$TOTAL" ]; do
    BODY="$(sed -n "${START},$((START + BATCH - 1))p" "$KEYWORDS_FILE" | node -e '
      const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
      process.stdout.write(JSON.stringify({
        platform: "android", appId: process.argv[1], country: process.argv[2],
        keywords: lines, defer: true,
      }));' "$APP_ID" "$COUNTRY")"
    echo "POST ${COUNTRY} keywords ${START}-$((START + BATCH - 1 < TOTAL ? START + BATCH - 1 : TOTAL)) of ${TOTAL}"
    curl -sS --fail-with-body -X POST "${BASE_URL}/api/aso/keywords" \
      ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
      -H "Content-Type: application/json" \
      --data "$BODY"
    echo
    START=$((START + BATCH))
  done
done
