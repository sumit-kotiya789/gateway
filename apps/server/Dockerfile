# syntax=docker/dockerfile:1
# Build context: repo root. Same image runs api / worker / watcher (different CMD).
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter @gw/server build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Bundle is self-contained (esbuild); no node_modules in the runtime image.
COPY --from=build /src/apps/server/dist/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--enable-source-maps", "api.cjs"]
