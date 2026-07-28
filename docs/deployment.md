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

## Deploying alongside an existing stack

Where a reverse proxy already owns 80/443 — the n8n VPS is the case this was
written for — use `docker-compose.vps.yml` instead. It drops the bundled Caddy,
joins the existing Docker network, and runs a prebuilt image.

**Build on a workstation, not the server.** `npm ci` pulls devDependencies
including Playwright, and `better-sqlite3` may compile from source; that is a
poor fit for a 2GB box already running other services. Ship the finished image
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
  answers 403 once a burst is too large; a blocked storefront recovers on its
  own after a while. Concurrency is capped at 3 in compose. Scheduled crawling
  across all 11 storefronts needs pacing between storefronts as well — that is
  Stage 2 work, so until then trigger refreshes deliberately rather than often.
- **Health**: `GET /health` is unauthenticated by design, for uptime probes. It
  touches neither the database nor Apple.
