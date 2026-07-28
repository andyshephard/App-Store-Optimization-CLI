# Deploy to the n8n VPS — step by step

Concrete runbook for `keywords.chunks.app` on `65.109.168.72`, alongside the
existing n8n + Caddy stack. Generic guidance is in `deployment.md`.

Each step says where to run it: **[Mac]** or **[VPS]**.

---

## 1. [DNS] Point the subdomain at the server

Add an **A record**: `keywords.chunks.app` → `65.109.168.72`

Wait for it to resolve before step 8 — Caddy cannot issue a certificate until it
does:

```bash
dig +short keywords.chunks.app
```

Expect `65.109.168.72`.

---

## 2. [Mac] Build the image for the server's architecture

The server is x86-64; your Mac is ARM, so the platform flag is required.

```bash
cd ~/Documents/projects/asocli
docker buildx build --platform linux/amd64 -t asocli:latest --load .
```

Takes a few minutes. Building on the VPS instead would likely exhaust its 2GB
of RAM.

---

## 3. [Mac] Ship the image to the server

~414MB uncompressed, roughly 150MB over the wire.

```bash
docker save asocli:latest | gzip | ssh root@65.109.168.72 'gunzip | docker load'
```

Expect `Loaded image: asocli:latest`.

---

## 4. [Mac] Generate the two secrets

```bash
openssl rand -hex 32
```

Save that as **API_TOKEN**.

```bash
docker run --rm caddy:latest caddy hash-password --plaintext 'pick-a-password'
```

Save the `$2a$14$...` output as **BCRYPT_HASH**, and remember the password
itself — it is what you type in the browser.

---

## 5. [Mac] Copy the compose file up

```bash
ssh root@65.109.168.72 'mkdir -p /opt/asocli'
scp docker-compose.vps.yml root@65.109.168.72:/opt/asocli/
```

---

## 6. [VPS] Write the environment file

```bash
ssh root@65.109.168.72
cd /opt/asocli

cat > .env <<'EOF'
ASO_API_TOKEN=PASTE_API_TOKEN
ASO_ALLOWED_ORIGIN=https://keywords.chunks.app
ASO_PRIMARY_APP_ID=6692632196
EOF

chmod 600 .env
```

Replace `PASTE_API_TOKEN` with the value from step 4.

---

## 7. [VPS] Start the container

```bash
cd /opt/asocli
docker compose -f docker-compose.vps.yml up -d
docker compose -f docker-compose.vps.yml logs --tail 20
```

Expect `ASO Dashboard: http://0.0.0.0:3456` and no exposure warning.

Check it from inside the Docker network (it is not reachable from outside yet,
by design):

```bash
docker exec n8n-docker-caddy-caddy-1 wget -qO- http://asocli:3456/health
```

Expect `{"success":true}`.

---

## 8. [VPS] Add the site to Caddy

Find the Caddyfile on the host:

```bash
docker inspect n8n-docker-caddy-caddy-1 \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

The entry ending `-> /etc/caddy/Caddyfile` is the file to edit. Back it up
first, then append the block:

```bash
cp <that-path> <that-path>.bak
nano <that-path>
```

Paste this below the existing `runner.chunks.app { ... }` block, replacing both
placeholders:

```
keywords.chunks.app {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		-Server
	}

	request_body {
		max_size 1MB
	}

	handle /health {
		reverse_proxy asocli:3456
	}

	@bearer header Authorization Bearer*
	handle @bearer {
		reverse_proxy asocli:3456
	}

	handle {
		basic_auth {
			owner PASTE_BCRYPT_HASH
		}
		reverse_proxy asocli:3456 {
			header_up Authorization "Bearer PASTE_API_TOKEN"
		}
	}
}
```

Reload:

```bash
docker exec n8n-docker-caddy-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

Silence means success. If it complains about `basic_auth`, the Caddy version is
older than 2.8 — rename it to `basicauth` and reload again.

---

## 9. [Mac] Verify from outside

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://keywords.chunks.app/health
# expect 200

curl -s -o /dev/null -w '%{http_code}\n' https://keywords.chunks.app/
# expect 401  (basic auth challenge)

curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer PASTE_API_TOKEN" \
  https://keywords.chunks.app/api/aso/storefronts
# expect 200

curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer wrong" \
  https://keywords.chunks.app/api/aso/storefronts
# expect 401
```

---

## 10. [Browser] Log in to Apple

Open `https://keywords.chunks.app`, enter the username 'owner' and the basic-auth password from step 4,
then complete the Apple login in the dashboard: Apple ID, password, two-factor
method, and the 6-digit code from your device.

**No SSH or terminal needed** — the prompts are served over HTTP.

Answer **no** to "remember credentials"; there is no credential store in the
container and the save is a deliberate no-op.

---

## 11. [Mac] Stop restarts from triggering an unpaced crawl

```bash
curl -X PATCH https://keywords.chunks.app/api/dashboard/settings \
  -H "Authorization: Bearer PASTE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"refreshMode":"manual"}'
```

Without this, every container restart kicks off a crawl of all 11 storefronts
at once, which is what got four of them rate-limited by Apple during testing.

---

## 12. [optional] Carry over the existing keyword data

Skip if you would rather the server build its own history from scratch.

**[Mac]** stop anything using the local database, then checkpoint it so the
copy is complete (recent writes live in the `-wal` file):

```bash
pkill -f "cli/dist/cli.js"
sqlite3 ~/.aso/aso-db.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
scp ~/.aso/aso-db.sqlite root@65.109.168.72:/tmp/aso-db.sqlite
```

**[VPS]**:

```bash
cd /opt/asocli
docker compose -f docker-compose.vps.yml stop
docker run --rm -v asocli_aso-data:/dst -v /tmp:/src alpine \
  sh -c 'cp /src/aso-db.sqlite /dst/aso-db.sqlite && chown 1000:1000 /dst/aso-db.sqlite'
docker compose -f docker-compose.vps.yml start
rm /tmp/aso-db.sqlite
```

Confirm the volume name first with `docker volume ls | grep aso` — it is
prefixed with the compose project directory name.

---

## 13. [n8n] Call it over the internal network

In n8n, use `http://asocli:3456`, **not** the public hostname. Both containers
are on `n8n-docker-caddy_default`, so this skips TLS and the public round trip
entirely, and keeps working if the certificate or DNS breaks.

Add an n8n **Header Auth** credential:

- Name: `Authorization`
- Value: `Bearer PASTE_API_TOKEN`

Smoke test with an HTTP Request node:

```
GET http://asocli:3456/api/aso/keywords?country=GB&appId=6692632196&pageSize=500
```

---

## Rollback

```bash
cd /opt/asocli && docker compose -f docker-compose.vps.yml down
cp <caddyfile>.bak <caddyfile>
docker exec n8n-docker-caddy-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

The `aso-data` volume survives; `docker compose ... down -v` would delete it
along with the Apple session.
