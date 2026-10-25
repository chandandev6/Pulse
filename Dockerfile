# One Dockerfile, three images (pick one with --target):
#   api  → the API, the worker and the migration job (same code, different command)
#   web  → nginx serving the built dashboard and forwarding API calls

# ---------- base: Node + pnpm ----------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# ---------- build: install everything, compile everything ----------
FROM base AS build
# Package files first: Docker caches this layer, so editing code doesn't reinstall
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY examples/node-app/package.json examples/node-app/
RUN pnpm install --frozen-lockfile
COPY . .
# The dashboard reports its own errors when PULSE_WEB_DSN is set (a public DSN, fine to bake in)
ARG PULSE_WEB_DSN=""
ARG PULSE_RELEASE=""
ENV VITE_PULSE_DSN=$PULSE_WEB_DSN VITE_PULSE_RELEASE=$PULSE_RELEASE
RUN pnpm --filter @pulse/shared build \
 && pnpm --filter @pulse/sdk build \
 && pnpm --filter @pulse/api exec tsc -p tsconfig.json \
 && pnpm --filter @pulse/web build

# ---------- api: only what the API needs to run ----------
FROM base AS api
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY apps/api/package.json apps/api/
# Production dependencies only (no Vitest, drizzle-kit, TypeScript...)
RUN pnpm install --frozen-lockfile --prod --filter @pulse/api...
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/sdk-js/dist packages/sdk-js/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
WORKDIR /app/apps/api
# Don't run as root: if the app is ever broken into, the attacker isn't root either
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

# ---------- web: static files + reverse proxy ----------
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
