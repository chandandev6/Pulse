# Pulse

Self-hosted application error tracking and incident response platform.

**Detect → Group → Understand → Alert → Acknowledge → Escalate → Resolve**

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
  api/        Backend server (Fastify)
  web/        Dashboard (coming soon)
packages/
  sdk-js/     JavaScript SDK (coming soon)
  shared/     Shared code between apps
```

## Getting started

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

## Sending errors from your app

Use the SDK in [`packages/sdk-js`](packages/sdk-js/README.md). The example in
[`examples/node-app`](examples/node-app/server.js) breaks on purpose so you can watch issues appear.

See [PRD.md](PRD.md) for the full plan and progress.
