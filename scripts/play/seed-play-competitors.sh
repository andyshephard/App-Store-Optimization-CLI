#!/usr/bin/env bash
# Track a file of Google Play competitor packages through a running asocli's API.
#
#   ASO_BASE_URL=https://keywords.chunks.app ASO_API_TOKEN=... \
#     scripts/play/seed-play-competitors.sh scripts/play/chunks-play-competitors.txt
#
# One POST /api/apps with platform=android per package. No Play request is
# made: ranks are read from the top 30 already stored for each keyword, and
# rank history is recorded from the next crawl. Re-running is harmless
# ("added": false for packages already tracked). Lines starting with # are
# ignored, and anything after the package on a line is a note. Remove one in
# the dashboard (Google Play apps, ×) or with DELETE /api/apps.
set -euo pipefail

FILE="${1:?usage: seed-play-competitors.sh <packages-file>}"
BASE_URL="${ASO_BASE_URL:-http://127.0.0.1:3456}"

# The token goes to curl as a config file on stdin (printf is a shell
# builtin), never on curl's command line, where other users could read it.
auth_config() {
  if [ -n "${ASO_API_TOKEN:-}" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$ASO_API_TOKEN"
  fi
}

grep -v '^[[:space:]]*#' "$FILE" | awk 'NF { print $1 }' | while read -r PACKAGE; do
  echo "POST ${PACKAGE}"
  auth_config | curl -sS --fail-with-body -K - -X POST "${BASE_URL}/api/apps" \
    -H "Content-Type: application/json" \
    --data "{\"platform\":\"android\",\"appId\":\"${PACKAGE}\"}"
  echo
done
