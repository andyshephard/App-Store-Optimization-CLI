# Deploying the dashboard

Runs the dashboard and its API on a server, reachable over HTTPS, so automation
(n8n) can read the data without a laptop being open.

Everything below has been exercised in a local Linux container. Where something
is untested on a real VPS it says so.

## Shape

```
internet ──▶ Caddy (80/443, TLS)  ──▶ asocli:3456   (expose only, no host port)
                │                          │
                │ browser: basic auth,      └── /home/node/.aso  (named volume)
                │   injects the API token       aso-db.sqlite, aso-cookies.json,
                │ n8n: passes its own bearer    config.json
```

Two layers of authentication, deliberately:

- **Caddy** authenticates humans with basic auth and injects
  `Authorization: Bearer <ASO_API_TOKEN>` on the way upstream, so the browser
  never holds the API token and the SPA needs no changes.
- **The app** validates that bearer on every request. A request that arrives
  with its own bearer (n8n) skips basic auth and is validated by the app, so
  that branch weakens nothing.

The app refuses to start on a non-loopback host without `ASO_API_TOKEN`, so
"exposed and unauthenticated" is unreachable rather than merely discouraged.

## One-time setup

1. **Generate secrets.**

   ```bash
   openssl rand -hex 32                                    # ASO_API_TOKEN
   docker run --rm caddy:2.8 caddy hash-password --plaintext 'your-password'
   ```

2. **Write `.env`** next to `docker-compose.yml` (gitignored; `chmod 600`):

   ```
   ASO_DOMAIN=aso.example.com
   ASO_ACME_EMAIL=you@example.com
   ASO_API_TOKEN=<64 hex chars>
   ASO_UI_BCRYPT_HASH=<hash from above>
   ASO_ALLOWED_ORIGIN=https://aso.example.com
   ASO_PRIMARY_APP_ID=6692632196
   ```

   `ASO_PRIMARY_APP_ID` matters more than it looks: the primary App ID normally
   lives in the SQLite `metadata` table, so a fresh volume without it sits
   waiting on an interactive setup prompt. Setting it skips that entirely.

3. **Point DNS** at the VPS and open only 22/80/443. Do not open 3456 — the app
   service uses `expose`, not `ports`, precisely so the port is unreachable from
   outside the Docker network. Publishing it would bypass UFW, because Docker
   writes its own iptables rules.

4. **Start it.**

   ```bash
   docker compose up -d --build
   docker compose logs -f asocli
   ```

## First login

Browse to `https://<domain>`, authenticate with basic auth, and complete the
Apple login in the UI. **No SSH and no terminal is needed**: the prompt handler
is HTTP-driven, so Apple ID, two-factor method and the verification code are all
entered in the browser.

Answer **no** to "remember credentials". The macOS Keychain is the only
credential store implemented, and the container sets
`ASO_DISABLE_CREDENTIAL_STORE=1`; the save is a guarded no-op, so answering yes
is harmless but pointless.

Then set the refresh mode to manual, so a restart never kicks off an unpaced
crawl of every storefront:

```bash
curl -X PATCH https://<domain>/api/dashboard/settings \
  -H "Authorization: Bearer $ASO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"refreshMode":"manual"}'
```

### Migrating an existing session instead

You can seed the volume from a working machine rather than logging in again:

```bash
docker run --rm -v aso-data:/dst -v "$HOME/.aso":/src:ro alpine \
  sh -c 'cp /src/aso-cookies.json /src/aso-db.sqlite /src/config.json /dst/ && chown -R 1000:1000 /dst'
```

**The cookie jar rotates**, so copy it immediately before starting the container
— a jar captured the previous day failed with `AUTH_REQUIRED` in testing while
the same file worked on the source machine, because the source had refreshed it
in the meantime. Treat this as a shortcut for the first run, not a way to avoid
ever logging in.

## Scheduling

The server owns its own clock. Set `ASO_REFRESH_DAILY_AT` (`HH:MM`) and
`ASO_REFRESH_TIMEZONE` (IANA name) and it refreshes every day at that wall-clock
time, writing straight to SQLite — no external trigger, and the data is current
whether or not anything calls the API. Unset the time to disable it.

`GET /api/aso/refresh-status` reports `schedule.nextRunAt` so you can confirm it
is armed. Timezone handling is DST-aware: 04:00 local stays 04:00 across both
transitions rather than drifting an hour.

Every run is recorded in `refresh_runs` / `refresh_run_storefronts`. A run still
marked running when the process starts again was interrupted (OOM, deploy,
reboot); if it was a scheduled or catch-up run, a forced catch-up run starts
once. `ASO_REFRESH_MAX_CATCHUPS_PER_DAY` (default 2, `0` disables) caps catch-ups
per 24h so a crawl that kills the process cannot loop; hitting the cap is
reported as `restart_loop` in `/api/aso/health` and emailed.

`GET /api/aso/health` (authenticated) is the place to check whether the data is
current: per-storefront last success, last-run counters and failure reasons,
and `ok | degraded | down`. See `docs/api.md`.

This is separate from `refreshMode`, which only controls the one-shot refresh at
container startup. Keep that on `manual`, or every restart kicks off an unpaced
crawl at an arbitrary time.

Consumers should then only ever **read**. These endpoints are pure database
reads and safe to poll: `/health`, `/api/aso/keywords`,
`/api/aso/keywords/history`, `/api/aso/storefronts`, `/api/aso/refresh-status`,
`/api/dashboard/settings`. These reach out to Apple or SensorTower as a side
effect and should be avoided by automation: `/api/apps`, `/api/aso/top-apps`,
`/api/aso/apps` and `/api/aso/apps/search`.

## Request rates

Every request to Apple goes through a per-host limiter
(`cli/shared/apple-rate-limiter.ts`). Each host class has a cap in requests per
minute and requests are spaced at least `60s / cap` apart, so no 60-second
window carries more than the cap - whatever the concurrency settings.

| Host class | Host | Env (requests/min) | Default |
|---|---|---|---|
| `mzsearch` | `search.itunes.apple.com` (MZSearch order and autocomplete hints) | `ASO_RATE_MZSEARCH_PER_MIN` | 30 |
| `searchpage` | `apps.apple.com` (search page and app pages) | `ASO_RATE_SEARCHPAGE_PER_MIN` | 15 |
| `lookup` | `itunes.apple.com/lookup` | `ASO_RATE_LOOKUP_PER_MIN` | 15 |
| `popularity` | `app-ads.apple.com` | `ASO_RATE_POPULARITY_PER_MIN` | 4 |

**How the defaults were set (today's effective rate).** Before the limiter the
only pacing was sleeps: a 15 s pause after each 25-keyword batch and 60 s
between storefronts. Per keyword the crawl made one MZSearch request and one
lookup, back to back, at Apple's latency (~0.3 s each). So a batch was ~15 s of
requests then 15 s of pause: about 25 MZSearch and 25 lookups per 30 s, i.e.
~50/min each while inside a storefront, and lower on average once the 60 s
storefront pauses are counted (the 2026-07-28 measurement: ~152 s of request
work across 12 storefronts, the rest pauses). The defaults sit below that:
MZSearch 30/min; lookups 15/min (lookups are now merged per batch, ~3-5 per 25
keywords, so 15/min is not the bottleneck); the search page 15/min, because the rank
prefix is new traffic to a host that throttles per storefront (and the VPS
compose starts with the prefix off, `ASO_RANK_SEARCHPAGE_PREFIX=0`); popularity 4/min (1-2 requests per batch). The sleeps are
now only breathing room: 5 s between batches, 15 s between storefronts. These
estimates assume ~0.3 s latency; the first run's `requests` line (below) gives
the measured figures.

**Concurrency** (`ASO_STOREFRONT_CONCURRENCY`, `ASO_SEARCH_CONCURRENCY`,
default 1) only fills the schedule faster - several storefronts or keywords
waiting on the same host still get one slot per `60s / cap`. Raising
concurrency alone cannot raise the request rate; raising a cap does.

**Adaptive guard.** A 429 or 503 (and 403, except from `app-ads.apple.com`,
where 403 is usually auth) halves that host's effective rate for 30 minutes,
logged as `[apple-rate] <host> answered <status>; rate A -> B/min`. After the
hold it recovers by 10% of the cap every 5 minutes, never above the cap.

**Metrics.** Each run stores, in `refresh_runs.counters_json.requests` and in
`GET /api/aso/health` under `lastRun.requests`: run duration and, per host,
requests, 429/403/5xx and throttle counts, and requests per minute; plus the
caps and effective rates at the end of the run. `rateLimits` in the health
report shows the current effective rate per host. The run log has one line:
`[aso-refresh] requests durationMs=... mzsearch=N(R/min,429=..,403=..,5xx=..) ...`.

**Expected runtime.** With the search-page prefix off (VPS night 1) each
keyword needs one MZSearch request, so the crawl runs at ~30 keywords/min:
total minutes ≈ keywords / 30, plus 5 s per batch and 15 s per storefront. For
example 1,000 tracked keywords across 12 storefronts: ~33 + ~3.5 + ~2.75 ≈ 40
min, at most 30 requests/min to MZSearch and ~4-10/min to lookup. With the
prefix on, each keyword also needs a search-page request at 15/min, which then
sets the pace: ~15 keywords/min, ~70 min for the same 1,000 until that cap is
raised. The old pacing did the same keywords in roughly 30-35 min, but in
bursts of ~50/min per host inside a storefront, and with no limit on retries or
on dashboard traffic running at the same time.

### Rate experiment plan

Goal: find how fast Apple lets this box crawl without being throttled.

1. **Night 1 - defaults, prefix off.** Caps as above,
   `ASO_STOREFRONT_CONCURRENCY=1`, `ASO_RANK_SEARCHPAGE_PREFIX=0` (as the VPS
   compose ships). Next morning read `lastRun.requests` in `/api/aso/health`:
   every host should show 0 for 429/403/5xx and `throttles`. Note the run
   duration.
2. **Night 2 - turn the search-page prefix on, nothing else.**
   `ASO_RANK_SEARCHPAGE_PREFIX=1` at `ASO_RATE_SEARCHPAGE_PER_MIN=15`. Check the
   `searchpage` host shows no 403/429 (apps.apple.com throttles per storefront
   with 403) and that ranks 1-11 look right in the dashboard. If it throttles,
   turn the prefix back off and leave it there.
3. **Night 3.** `ASO_STOREFRONT_CONCURRENCY=2`, and raise
   `ASO_RATE_LOOKUP_PER_MIN` and `ASO_RATE_MZSEARCH_PER_MIN` (and
   `ASO_RATE_SEARCHPAGE_PER_MIN` if the prefix is on) by ~25%: 30 -> 38,
   15 -> 19.
4. **Each following night**, if the previous run had no 429/403/5xx and no
   `[apple-rate]` warnings, raise those caps by another ~25% (38 -> 48 -> 60 ...).
5. **Stop at the first night with any throttle** on that host. The adaptive
   guard will already have halved the rate for that run.
6. **Settle at 75% of the highest clean rate**: e.g. clean at 48, throttled at
   60 -> set 36. Record the result here with the date.

Change one thing per night (in the compose `environment` block or the
environment file, then `docker compose -f docker-compose.vps.yml up -d`). Keep
popularity at its default - that endpoint is the Apple ID session, not a search
host.

### Rate experiment result (2026-10-29)

Run back to back as forced crawls on the CPX22 (345 keywords, 12 storefronts),
not one step per night. Popularity stayed at 4/min throughout.

| Step | Storefronts at once | Caps mzsearch / searchpage / lookup | Crawl | Result |
|---|---|---|---|---|
| 1 | 1 | 30 / 15 / 15, prefix off | 26 min | clean |
| 2 | 1 | 30 / 15 / 15, prefix on | 29 min | clean (21 search-page 500s, see below) |
| 3 | 2 | 38 / 19 / 19 | 20 min | clean (24 500s) |
| 4 | 2 | 48 / 24 / 24 | 16 min | clean (24 500s) |
| 5 | 2 | 60 / 30 / 30 | 13 min | clean (27 500s); searchpage ran 28.3/min |
| 6 | 2 | 75 / 38 / 38 | 15 min | **one 429 on searchpage**; the limiter halved it to 19 |

Settled at 75% of the highest clean caps (step 5), concurrency 2, prefix on:
`ASO_RATE_MZSEARCH_PER_MIN=45`, `ASO_RATE_SEARCHPAGE_PER_MIN=22`,
`ASO_RATE_LOOKUP_PER_MIN=22`, `ASO_STOREFRONT_CONCURRENCY=2`,
`ASO_RANK_SEARCHPAGE_PREFIX=1`. The search page (apps.apple.com) is the
binding limit; mzsearch never throttled and is paced by it. Lookups are mostly
served from cache (~310 of ~370 per crawl).

The search-page 500s are not a rate signal: the same terms fail on every
attempt at every rate. On 2026-10-29 they were US "trivia", "quiz",
"trivia quiz", "history quiz", "daily trivia", FR and IT "quiz", and PT
"conhecimento". Those keywords keep their MZSearch rank. When judging a crawl,
count 429/403/throttles, and 5xx only above that known baseline.

## When the Apple session expires

It will, and there is no unattended fix: Apple requires a 2FA code from a
trusted device.

Automation should **detect and alert**, never attempt the login:

- `GET /api/aso/refresh-status` → `requiresReauthentication: true` is the
  authoritative signal; the crawl aborts the moment it sees this.
- Any `/api/*` call returning 401 `AUTH_REQUIRED`. Note this is ambiguous — it
  also means a wrong API token — so probe `/health` first to prove reachability.

**n8n must not call `POST /api/aso/auth/start`.** The prompt session is a single
slot: an unattended start parks on the credentials prompt and holds it, and your
later attempt in the browser is refused with "Another interactive prompt is
already pending" until the container restarts. Alert, then log in yourself.

To log in, open the dashboard and press **Reconnect Apple** in the toolbar. It
appears whenever the refresh reports `requiresReauthentication`, or the session
keeper's silent re-login hit 2FA (`sessionKeeper.needsTwoFactor` on
`GET /api/aso/refresh-status`). It runs the same browser prompt flow as the
first login: choose a verification method, then enter the code.

Unattended re-logins (the session keeper, and the popularity stage's one silent
retry) never prompt. Without a prompt handler and a TTY, a 2FA challenge throws.
Before this fix it fell through to an inquirer prompt on the container's closed
stdin, which exits the process. The container restarted and the browser never
got a code field.

Every unattended re-login is a full Apple sign-in, and too many from one IP
make idmsa answer **503 to every login**, the dashboard's included
(`Apple login failed with status 503`). The popularity stage therefore shares
one attempt between concurrent callers and stops trying for an hour after a
failure. A dashboard login clears that cooldown. If you hit the 503, wait a
few hours before pressing Reconnect again; every attempt extends the block.

## Deploying alongside an existing stack

Where a reverse proxy already owns 80/443 — the n8n VPS is the case this was
written for — use `docker-compose.vps.yml` instead. It drops the bundled Caddy,
joins the existing Docker network, and runs a prebuilt image.

**Build on a workstation, not the server.** `npm ci` pulls devDependencies
including Playwright, and `better-sqlite3` may compile from source; that is a
poor fit for the VPS (Hetzner CPX22, 4 GB RAM shared with n8n, and for now
an old Ghost + MySQL due to be removed; ~2 GB was free on 2026-10-29). Ship the finished image
over SSH instead — no registry required:

```bash
# on the workstation, targeting the server's architecture
docker buildx build --platform linux/amd64 -t asocli:latest --load .
docker save asocli:latest | gzip | ssh root@<host> 'gunzip | docker load'
```

Then on the server, in a directory holding `docker-compose.vps.yml` and `.env`:

```bash
docker compose -f docker-compose.vps.yml up -d
docker compose -f docker-compose.vps.yml logs -f
```

After every deploy, remove the image the new one replaced - each `docker load`
leaves the previous `asocli:latest` behind as a dangling image of several
hundred MB:

```bash
docker image prune -f
```

`docker-compose.vps.yml` caps this container's logs (json-file, 3 x 10 MB).
n8n's compose file is not in this repo and its logs are just as unbounded;
add the same block to its service there (not done for you):

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Logging options apply when a container is recreated (`up -d` after the edit),
not to a running one.

Add the site block from `caddy-snippet.txt` to the existing Caddyfile and
reload: `docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile`.
An A record for the new subdomain must resolve before Caddy will issue a
certificate.

Serve it on its own subdomain rather than a path on an existing one. The
dashboard requests `/api/*`, `/runtime-config.js` and `/assets/*` as absolute
paths, so a sub-path deployment would need rewriting inbound and would still
generate wrong URLs outbound.

**Automation should use the internal network, not the public hostname.** With
both containers on the same Docker network, n8n calls `http://asocli:3456`
directly with its bearer token — no TLS handshake, no public round trip, and it
keeps working if the certificate or DNS has a problem. The public subdomain is
then only for your browser.

## Operating notes

- **One instance only.** SQLite is single-writer and the auth/setup managers are
  module-level singletons.
- **Backups**: stop the container (or accept a WAL-consistent copy) and archive
  the `aso-data` volume. `aso-cookies.json` is the only thing that is painful to
  recreate.
- **Upgrades**: `docker compose up -d --build`. Shutdown is graceful — SIGTERM
  stops the refresh at its next batch boundary rather than mid-request to Apple,
  then checkpoints and closes SQLite.
- **Rate limiting**: Apple throttles the app-detail endpoint per storefront and
  per client, answering 403 after roughly 100–200 rapid requests to one
  storefront. Recovery is seconds rather than minutes, and one client being
  throttled does not affect another — a workstation was blocked on US while the
  server crawled US with zero failures. Concurrency is capped at 3 in compose. Scheduled crawling
  across all 11 storefronts needs pacing between storefronts as well — that is
  Stage 2 work, so until then trigger refreshes deliberately rather than often.
- **Health**: `GET /health` is unauthenticated by design, for uptime probes. It
  touches neither the database nor Apple.
