# Pulse

Self-hosted application error tracking and incident response platform.

**Detect → Group → Understand → Alert → Acknowledge → Escalate → Resolve**

## Run Pulse (self-hosting)

You need Docker. Then:

```bash
cp .env.prod.example .env.prod        # set APP_SECRET and POSTGRES_PASSWORD inside
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Open http://localhost:8080, sign up, create a project, and copy its DSN into your app.
HTTPS, hosted databases (Neon), backups and limits are covered in the
**[self-hosting guide](docs/self-hosting.md)**.

## Docs

- [Self-hosting guide](docs/self-hosting.md)
- [SDK guide](packages/sdk-js/README.md)
- [API reference](docs/api.md)

## Tech stack

- **API:** Node.js, TypeScript, Fastify, Zod
- **Database:** PostgreSQL (Drizzle ORM)
- **Cache / queues:** Redis (ioredis)
- **Tests:** Vitest
- **Lint & format:** Biome
- **Monorepo:** pnpm workspaces

## Project structure

```
apps/
  api/        API server + worker (Fastify, BullMQ)
  web/        Dashboard (React + Vite)
packages/
  sdk-js/     JavaScript SDK (@pulse/sdk)
  shared/     Code shared by the API and the SDK (event schema)
examples/
  node-app/   A small app that breaks on purpose
deploy/       nginx config for production
docs/         Self-hosting guide, API reference
scripts/      Load test
```

## Development

### 1. Requirements

- Node.js 22+
- pnpm 10+
- Docker

### 2. Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm --filter @pulse/api db:migrate
```

### 3. Run

```bash
pnpm dev       # API + web app
pnpm worker    # in a second terminal: saves incoming error events
```

Check it works: open http://localhost:3000/health

## Scripts

| Command          | What it does                   |
| ---------------- | ------------------------------ |
| `pnpm dev`       | Start all apps in watch mode   |
| `pnpm worker`    | Start the event worker         |
| `pnpm example`   | Run the example app (needs `PULSE_DSN`) |
| `pnpm test`      | Run all tests                  |
| `pnpm typecheck` | Check TypeScript types         |
| `pnpm lint`      | Check code with Biome          |
| `pnpm format`    | Auto-fix formatting with Biome |
| `pnpm e2e`       | Browser tests (Playwright)     |
| `pnpm load-test` | Load test ingestion (needs `PULSE_DSN`) |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and builds on every push and pull
request. It also checks that the production Docker images still build.

## Sending errors from your app

Use the SDK in [`packages/sdk-js`](packages/sdk-js/README.md). The example in
[`examples/node-app`](examples/node-app/server.js) breaks on purpose so you can watch issues appear.

See [PRD.md](PRD.md) for the full plan and progress.
