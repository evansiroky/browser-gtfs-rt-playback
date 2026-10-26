# One image: the Node server plus the built web app (specs/architecture.md "Packaging").
# Build context is the repository root:  docker build -t gtfs-rt-debugger .
#
# The base image is pinned to the Node 22 major (package.json requires >=22.12). Pinning to a digest
# is left to Renovate/CI so the pin can be refreshed without hand-edited hashes.

# ---- Stage 1: install everything and build shared, server and web ---------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests and the lockfile first: the dependency layer is rebuilt only when they change. Only the
# workspaces that get built (plus the root toolchain: typescript) are installed; fixtures and e2e are
# not in the image context.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace=shared --workspace=server --workspace=web --include-workspace-root \
    --no-audit --no-fund

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY web/ web/
# shared first: server and web consume its built output.
RUN npm run build -w shared -w server -w web

# ---- Stage 2: runtime, production dependencies only -----------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies of the server (and shared) only, restricted from the root lockfile: no
# devDependencies and none of the web toolchain, which is already compiled into web/dist.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace=shared --workspace=server --include-workspace-root=false \
    --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/*

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
# The server finds the web app at ../../web/dist relative to server/dist (WEB_DIST_DIR overrides it).
COPY --from=build /app/web/dist web/dist

# Cloud Run injects PORT (8080 by default); the server listens on it on all interfaces.
EXPOSE 8080
# Provenance, set by the build (docker build --build-arg GIT_SHA=$(git rev-parse HEAD) .). Declared this
# late so a new revision does not invalidate the cached dependency and copy layers above.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/evansiroky/gtfs-rt-debugger" \
      org.opencontainers.image.revision="$GIT_SHA"

# Never root: uid 1000 is the base image's `node` user (numeric so a host can resolve it). The image
# holds no secrets: feed URLs and tunables arrive as environment variables.
USER 1000:1000
# No HEALTHCHECK: Cloud Run ignores it and probes the TCP port instead.
# Node is PID 1 on purpose: the server handles SIGTERM/SIGINT itself and exits 0 within its 5 s drain,
# so no shell wrapper or init process (tini) sits between the platform's signal and the server. The base
# image's entrypoint script (docker-entrypoint.sh) only `exec`s the command, so PID 1 is node itself.
CMD ["node", "server/dist/main.js"]
