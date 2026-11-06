# syntax=docker/dockerfile:1
# Build context: repo root. Static SPA + nginx (serves files, proxies /v1/dashboard/* to the api).
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @gw/dashboard
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @gw/dashboard build

# Unprivileged image: runs as uid 101 on :8080; pid and temp files live in /tmp (tmpfs in compose).
FROM nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
# Pick up Alpine security fixes released after the base image was built (trivy gate).
USER root
RUN apk upgrade --no-cache
USER 101
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/dashboard/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /src/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ || exit 1
