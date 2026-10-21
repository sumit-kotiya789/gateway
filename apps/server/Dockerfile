# syntax=docker/dockerfile:1
# Build context: repo root. Same image runs api / worker / watcher / migrate (different CMD).
FROM node:26-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
# Every workspace package the server depends on must be listed here (manifest first for layer caching).
COPY packages/core/package.json packages/core/
COPY packages/chains/package.json packages/chains/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/chains packages/chains
COPY apps/server apps/server
RUN pnpm --filter @gw/server build

FROM node:26-alpine
ENV NODE_ENV=production
# Runtime never needs a package manager: drop npm/corepack (and their CVE surface) from the final image.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# Bundles are self-contained (esbuild); no node_modules in the runtime image.
COPY --from=build /src/apps/server/dist/ ./
COPY --from=build /src/apps/server/db/migrations ./db/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--enable-source-maps", "main-api.cjs"]
