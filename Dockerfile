# Node 20: scripts/check-node-version.js requires >= 20.19.0 for the build, and
# .nvmrc pins 20. Debian rather than Alpine because better-sqlite3 ships glibc
# prebuilds; musl would force a source build on every image rebuild.
FROM node:20-bookworm AS builder
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
FROM node:20-bookworm AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/node \
    ASO_DASHBOARD_HOST=0.0.0.0 \
    ASO_DASHBOARD_PORT=3456 \
    ASO_OPEN_BROWSER=0 \
    ASO_DISABLE_UPDATE_CHECK=1 \
    ASO_DISABLE_CREDENTIAL_STORE=1
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

# node rather than curl: the slim image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3456/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "cli/dist/cli.js"]
