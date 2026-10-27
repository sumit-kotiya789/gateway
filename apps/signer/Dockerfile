# syntax=docker/dockerfile:1
# Build context: repo root. Custodial only (M7, D-088): the signer runs on its own host in production; this image is
# the same for both. CMD serves sign requests; `node cli/init-seed.cjs` creates a dev/test seed.
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
# Every workspace package the signer depends on must be listed here (manifest first for layer caching).
COPY packages/core/package.json packages/core/
COPY packages/chains/package.json packages/chains/
COPY apps/signer/package.json apps/signer/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/chains packages/chains
COPY apps/signer apps/signer
RUN pnpm --filter @gw/signer build

FROM node:22-alpine
ENV NODE_ENV=production
# Runtime never needs a package manager: drop npm/corepack (and their CVE surface) from the final image.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# Bundles are self-contained (esbuild); no node_modules in the runtime image.
COPY --from=build /src/apps/signer/dist/ ./
# Dev seed volume (local-file seed source); a fresh named volume inherits this owner.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3100
# Plain HTTP only (dev). With mTLS the check needs a client certificate; disable it and probe from the worker side.
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3100/healthz || exit 1
CMD ["node", "--enable-source-maps", "main.cjs"]
