# syntax=docker/dockerfile:1
# AgentOS — multi-stage image: compile in the build stage, ship only the
# compiled artifacts + production dependencies in the runtime stage.
#
# Published to GHCR on version tags (v*): ghcr.io/<owner>/agentos:<tag> and
# :latest. Data (SQLite DB, vault keys, blobs, work dirs) lives in /data.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
RUN npm install -g pnpm@11.7.0
WORKDIR /app

# Install with the lockfile first (dependency layer is cached).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# Build server + CLI + PWA web.
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    AGENTOS_DATA_DIR=/data \
    PNPM_HOME=/pnpm
RUN npm install -g pnpm@11.7.0

WORKDIR /app
# Production dependencies only, from the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile

# Compiled artifacts from the build stage.
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Run as an unprivileged user; /data is the only writable path.
RUN useradd --system --uid 10001 --create-home agentos \
    && mkdir -p /data \
    && chown -R agentos:agentos /data
USER agentos

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/api/server.js"]
