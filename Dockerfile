# Node 22: scripts/check-node-version.js requires >= 22.22.0 for the build
# (posthog-node's floor on the 22 line), and .nvmrc pins 22. Debian rather than Alpine because better-sqlite3 ships glibc
# prebuilds; musl would force a source build on every image rebuild.
FROM node:22-bookworm AS builder
WORKDIR /app
# Toolchain for the case where no better-sqlite3 prebuild matches this arch/ABI.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# Production dependencies only. esbuild marks axios, better-sqlite3, dotenv,
# yargs, zod and zod-validation-error as external, so cli/dist/cli.js is not
# self-contained and needs a real node_modules at runtime.
FROM node:22-bookworm AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/node \
    ASO_DASHBOARD_HOST=0.0.0.0 \
    ASO_DASHBOARD_PORT=3456 \
    ASO_OPEN_BROWSER=0 \
    ASO_DISABLE_UPDATE_CHECK=1
# ASO_DISABLE_CREDENTIAL_STORE is deliberately not set here: the keychain
# service already no-ops on any non-darwin platform, so it is redundant inside a
# Linux image, and the name trips BuildKit's secrets-in-ENV lint. The compose
# files still set it, where it documents intent without the false positive.
WORKDIR /app

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/cli/dist     ./cli/dist
COPY package.json ./

# Create and own the state directory *before* declaring the volume, so Docker
# copies node's ownership onto a fresh named volume. Without this the first
# write fails with EACCES. config.json and aso-cookies.json are hardcoded to
# $HOME/.aso, so HOME must be a real writable directory.
RUN mkdir -p /home/node/.aso && chown -R node:node /home/node
USER node
VOLUME ["/home/node/.aso"]

EXPOSE 3456

# bash's /dev/tcp rather than node or curl: the slim image has no curl, and
# spawning a second node every probe cost ~40 MB RSS and ~100 ms CPU each time
# inside a 512 MB container. HTTP/1.0 so the server closes the connection.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/3456 && printf 'GET /livez HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n 1 <&3 | grep -q ' 200 '"]

CMD ["node", "cli/dist/cli.js"]
