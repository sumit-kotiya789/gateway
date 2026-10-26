# syntax=docker/dockerfile:1
# Build context: repo root. Static admin SPA + nginx (serves files under /admin/, proxies /admin/v1/* to the api).
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @gw/admin
COPY apps/admin apps/admin
# Shared UI kit and styles (React resolves from apps/admin, see vite.config.ts).
COPY apps/dashboard/src apps/dashboard/src
RUN pnpm --filter @gw/admin build

# Unprivileged image: runs as uid 101 on :8080; pid and temp files live in /tmp (tmpfs in compose).
FROM nginxinc/nginx-unprivileged:1.30.6-alpine
# Pick up Alpine security fixes released after the base image was built (trivy gate).
USER root
RUN apk upgrade --no-cache
USER 101
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/dashboard/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /src/apps/admin/dist /usr/share/nginx/html/admin
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/admin/ || exit 1
