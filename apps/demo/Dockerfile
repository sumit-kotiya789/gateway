# syntax=docker/dockerfile:1
# Build context: repo root. Demo web3 app (game wallet) on the gateway SDK: one bundled Node file.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/sdk-node/package.json packages/sdk-node/
COPY apps/demo/package.json apps/demo/
RUN pnpm install --frozen-lockfile --filter @gw/demo...
COPY packages/sdk-node packages/sdk-node
COPY apps/demo apps/demo
RUN pnpm --filter @gw/demo build

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /src/apps/demo/dist/ ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV DEMO_DATA_DIR=/data PORT=8083
EXPOSE 8083
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8083/healthz || exit 1
CMD ["node", "--enable-source-maps", "server.cjs"]
