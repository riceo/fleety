# ---- frontend build ----
FROM node:22-bookworm-slim AS webbuild
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- server build ----
FROM node:22-bookworm-slim AS serverbuild
# toolchain as fallback for native modules (better-sqlite3, argon2, sharp)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    PORT=8080
# curl is only here for platform healthchecks (Coolify probes with curl/wget)
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 fleetview && mkdir -p /data && chown fleetview /data
WORKDIR /app
COPY --from=serverbuild /app/server/node_modules server/node_modules
COPY --from=serverbuild /app/server/dist server/dist
COPY --from=serverbuild /app/server/package.json server/package.json
COPY --from=webbuild /app/web/dist web/dist
USER fleetview
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS "http://localhost:8080/healthz" || exit 1
# The in-container port is pinned: platform-injected PORT vars (Coolify sets
# one from its UI) must not move the app away from the proxy/healthcheck target.
CMD ["sh", "-c", "PORT=8080 exec node server/dist/index.js"]
