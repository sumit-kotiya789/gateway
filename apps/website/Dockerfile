# syntax=docker/dockerfile:1
# Build context: repo root. Public site (landing, pricing, developer docs): static SPA + nginx.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/website/package.json apps/website/
RUN pnpm install --frozen-lockfile --filter @gw/website
COPY apps/website apps/website
ARG VITE_DASHBOARD_URL=http://localhost:8080
ARG VITE_DEMO_URL=http://localhost:8083
ENV VITE_DASHBOARD_URL=$VITE_DASHBOARD_URL VITE_DEMO_URL=$VITE_DEMO_URL
RUN pnpm --filter @gw/website build

# Unprivileged image: runs as uid 101 on :8080; pid and temp files live in /tmp (tmpfs in compose).
FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
# Pick up Alpine security fixes released after the base image was built (trivy gate).
USER root
RUN apk upgrade --no-cache
USER 101
COPY apps/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/dashboard/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /src/apps/website/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ || exit 1
