# Pulse — Product Requirements & Build Tracker

> Self-hosted application error tracking and incident response platform.
> **Detect → Group → Understand → Alert → Acknowledge → Escalate → Resolve**

This file is the single source of truth for **what Pulse is**, **how each feature is built**, and **where we are right now**. We build **one feature at a time, in order**. A feature is only marked done after it is implemented, tested, and reviewed.

---

## 📍 Current Position

| | |
|---|---|
| **Current feature** | F11 — Notification Channels |
| **Status** | 👀 F11 built on `dev` (uncommitted), waiting for review + commit. F8–F10 are merged into `main` and pushed |
| **Working branch** | `dev`. `main` = `dev` = `origin` = `bd64afa` (F10 included) |
| **Last completed** | F8, F9 and F10 merged into `main` |
| **Next step** | Review + commit F11 (migration 0008 is applied locally); finish Lesson 54; F11 walkthrough (Lesson 55) |
| **Next feature** | F12 — On-Call Schedules |

### Learning Log
| Lesson | Topic | Status |
|---|---|---|
| 1 | Git basics: add → commit → push, first push of PRD | ✅ |
| 2 | Tools (Node, pnpm, TS, Docker), branches, monorepo, `package.json`, `pnpm-workspace.yaml`, `.gitignore`, secrets & `.env` | ✅ |
| 3 | TypeScript config, `.editorconfig`, Docker Compose (images, containers, volumes, healthchecks), `.env` usage | ✅ |
| 4 | Servers, routes, requests/responses, JSON, ports; Fastify + Zod env validation + `/health` | ✅ |
| 5 | ORMs, connection pools, migrations (concept), graceful shutdown; Drizzle + ioredis; `/health` db/redis checks; debugging "module not found" / "not defined" | ✅ |
| 6 | Pretty logging, central error handler, first automated tests (Vitest) | ✅ |
| 7 | Biome (lint + format), root scripts, README | ✅ |
| 8 | Web app scaffold (Vite + React) → merge F0 into `main` | ✅ |
| 9 | Tables, primary/foreign keys, UUIDs, constraints, indexes; `users` + `sessions` schema; generate → read → migrate | ✅ |
| 10 | Hashing, salts, argon2 (`password.ts` + unit tests); signup validation + `POST /auth/signup` | ✅ |
| 11 | Login, sessions & cookies, `/auth/me`, logout | ✅ |
| 12 | `requireAuth` guard, rate limiting, auth tests → merge F1 into `main` | ✅ |
| 13 | F2 tables: many-to-many, enums, composite keys, per-org unique slugs | ✅ |
| 14 | Signup creates the first org: transactions (all or nothing) | ✅ |
| 15 | `requireOrgRole` / `requireProjectRole`: authorization, role ranking, 404 vs 403 | ✅ |
| 16 | Org + member routes, last-owner protection, row locks (`FOR UPDATE`) | ✅ |
| 17 | Project routes, public keys & DSN, rotate/revoke | ✅ |
| 18 | Role + cross-org isolation tests → merge F2 into `main` | ✅ |
| 19 | Shared package `@pulse/shared`: one event schema for API + SDK | ✅ |
| 20 | Ingest route: project-key auth, body size limit, defaults, 202 Accepted | ✅ |
| 21 | BullMQ: queues, jobs, retries with backoff, separate worker process | ✅ |
| 22 | `events` table, JSONB columns, worker saves events | ✅ |
| 23 | CORS (scoped to `/api`), idempotency with `ON CONFLICT DO NOTHING` | ✅ |
| 24 | Ingest tests (worker end-to-end) → merge F3 into `main` | ✅ |
| 25 | Fingerprints: normalizing stacks and messages, SHA-256 hashing | ✅ |
| 26 | `issues`, `issue_users`, `issue_activity` tables; Postgres enums | ✅ |
| 27 | Upserts (`ON CONFLICT DO UPDATE`), atomic counters, row locks in the worker | ✅ |
| 28 | Unique user counting, first/last seen with out-of-order events, regressions | ✅ |
| 29 | Grouping tests (1000 events race → 1 issue) → merge F4 into `main` | ✅ |
| 30 | SDK client: `init`, capture API, scope (user/tags/context), sampling, `beforeSend` | ✅ |
| 31 | Stack trace parsing (V8 + Firefox/Safari), in-app frames | ✅ |
| 32 | Transport: `fetch`, retries with backoff, fire-and-forget, `flush()` | ✅ |
| 33 | Global handlers (Node + browser) without changing the app's crash behaviour | ✅ |
| 34 | Fastify plugin + Express error handler, safe headers; tsup build (ESM + CJS) | ✅ |
| 35 | SDK tests + example app end to end → merge F5 into `main` | ✅ |
| 36 | Access through relations: issue → project → org (`requireIssueRole`, `requireEventRole`) | ✅ |
| 37 | Cursor (keyset) pagination vs offset; sorting with tie-breakers | ✅ |
| 38 | Triage: status/severity/assignee changes, activity log, row locks vs the worker | ✅ |
| 39 | Issue detail (latest event, env/release breakdown with GROUP BY), bulk updates, tests → merge F6 into `main` | ✅ |
| 40 | React app shell: React Router (nested routes, layouts, auth guard), Vite proxy for same-origin cookies | ✅ |
| 41 | TanStack Query: query keys, caching, infinite queries ("Load more"), mutations + invalidation | ✅ |
| 42 | Pages: login/signup, project switcher, overview stats (`/stats`), issues list with filters in the URL | ✅ |
| 43 | Issue detail: stack trace viewer, event navigator (prev/next), tags/context/request/user, actions, activity | ✅ |
| 44 | UI tests (Testing Library + fake API) and a real-browser e2e smoke test (Playwright) → merge F7 into `main` | ✅ |
| 45 | Full-text search (tsvector, websearch_to_tsquery, expression GIN index) + trigram fallback (pg_trgm), LIKE escaping | ✅ |
| 46 | Filters: comma lists, EXISTS subqueries, date ranges, org-wide list; event search on JSONB (->>, @>) | ✅ |
| 47 | Time-series: UTC buckets, GROUP BY, zero-filling, DB indexes + search tests | ✅ |
| 48 | Filter bar with every filter in the URL (debounced inputs), accessible frequency charts → merge F8 into `main` | ✅ |
| 49 | `releases` / `environments` tables filled by the worker (upserts, fixed lock order), backfill inside a migration | ✅ |
| 50 | First/last release per issue with out-of-order events (`CASE` in `ON CONFLICT DO UPDATE`) | ✅ |
| 51 | Release API: list with new-issue counts (`LEFT JOIN` on a grouped subquery), release detail, compare A vs B (`count(*) FILTER`) | ✅ |
| 52 | Dashboard: global environment selector (React context + per-project memory), releases + compare pages | ✅ |
| 53 | User impact: % of users and "high impact" badge; tests + e2e → merge F9 into `main` | ✅ |
| 54 | Alert rules: conditions as JSONB, Redis sliding windows (sorted sets), dedup with a partial unique index, cooldown → merge F10 into `main` | 🔄 |

### Progress Tracker

Legend: ⬜ Not started · 🔄 In progress · 👀 In review · ✅ Done

| # | Feature | Phase | Status |
|---|---|---|---|
| F0 | Project Setup | A — Foundation | ✅ |
| F1 | Auth & Users | A — Foundation | ✅ |
| F2 | Organizations, Projects & Roles | A — Foundation | ✅ |
| F3 | Event Ingestion API | B — Error Tracking | ✅ |
| F4 | Fingerprinting & Grouping | B — Error Tracking | ✅ |
| F5 | JS/Node SDK | B — Error Tracking | ✅ |
| F6 | Issue Management API | B — Error Tracking | ✅ |
| F7 | Dashboard UI | B — Error Tracking | ✅ |
| F8 | Search & Investigation | B — Error Tracking | ✅ |
| F9 | Releases, Environments & User Impact | B — Error Tracking | ✅ |
| F10 | Alert Rules | C — Incident Response | ✅ |
| F11 | Notification Channels | C — Incident Response | 👀 |
| F12 | On-Call Schedules | C — Incident Response | ⬜ |
| F13 | Incidents & Acknowledgement | C — Incident Response | ⬜ |
| F14 | Escalation Policies | C — Incident Response | ⬜ |
| F15 | Hardening & Deployment | D — Polish | ⬜ |

---

## 1. Product Overview

### 1.1 Problem
After an application is deployed, failures happen silently. Teams find out late (often from users), drown in duplicate error logs, and lose time deciding who should respond.

### 1.2 Solution
Pulse receives errors from applications, groups identical failures into **issues**, shows their **frequency and user impact**, and turns important issues into **incidents** that are routed to the **on-call** responder and **escalated** until someone acknowledges and resolves them.

### 1.3 Goals
- Reduce time between an application failure and a human response.
- Turn raw errors into organized, de-duplicated issues.
- Turn important issues into actionable incidents.
- Ensure critical incidents reach a responsible person — and escalate if they don't respond.
- Keep historical data for debugging and analysis.

### 1.4 Users & Roles
| Role | Can do |
|---|---|
| **Owner** | Everything in the org, incl. deleting org, managing billing-level settings, managing members |
| **Admin** | Manage projects, API keys, alert rules, schedules, escalation policies, members (except owners) |
| **Member** | View issues/incidents, resolve issues, acknowledge/resolve incidents, be on call |

### 1.5 Core Concepts (Glossary)
| Term | Meaning |
|---|---|
| **Organization** | A team/company. Contains projects and members. |
| **Project** | One application/service. Has its own API key (DSN) and its own error data. |
| **Event** | A single occurrence of an error, sent by an SDK. |
| **Fingerprint** | Hash that identifies the underlying problem an event belongs to. |
| **Issue** | A group of events sharing a fingerprint — one real problem. |
| **Release** | Application version that produced an event. |
| **Environment** | Where the event happened (production, staging, development…). |
| **Alert rule** | Condition that decides when an issue becomes an incident. |
| **Incident** | An actionable alert tied to an issue, with a lifecycle (triggered → acknowledged → resolved). |
| **On-call schedule** | Who is responsible for responding during which period. |
| **Escalation policy** | Ordered levels of responders + timeouts used when nobody acknowledges. |

---

## 2. Tech Stack & Architecture

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces |
| API | Node 22 + TypeScript + Fastify, Zod validation |
| Database | PostgreSQL + Drizzle ORM (migrations) |
| Queue / timers | Redis + BullMQ |
| Dashboard | React + Vite + TypeScript |
| SDK | `@pulse/sdk` (Node + browser) |
| Tests | Vitest |
| Local infra | Docker Compose (Postgres, Redis) |

### 2.1 Repository Layout
```
Pulse/
├── apps/
│   ├── api/            # Fastify HTTP API + BullMQ workers
│   └── web/            # React dashboard
├── packages/
│   ├── shared/         # Shared types & Zod schemas (event payload, enums)
│   └── sdk-js/         # Client SDK (@pulse/sdk)
├── examples/
│   └── node-app/       # Demo app that breaks on purpose
├── docker-compose.yml
├── PRD.md
└── README.md
```

### 2.2 High-Level Flow
```
App + SDK ──POST event──▶ Ingestion API ──enqueue──▶ [events queue]
                                                         │
                                                  Event worker
                                   fingerprint → upsert Issue → store Event
                                                         │
                                               Alert rule evaluation
                                                         │ (match)
                                                     Incident
                                                         │
                          On-call lookup → Notify level 1 → wait timeout
                                                         │ (not acked)
                                                  Escalate to level 2 …
                                                         │
                                          Acknowledge → Resolve
```

### 2.3 Core Data Model (grows feature by feature)
| Table | Key fields | Introduced in |
|---|---|---|
| `users` | id, email, password_hash, name | F1 |
| `sessions` | id, user_id, expires_at | F1 |
| `organizations` | id, name, slug | F2 |
| `memberships` | user_id, org_id, role | F2 |
| `projects` | id, org_id, name, slug, platform | F2 |
| `project_keys` | id, project_id, public_key, revoked_at | F2 |
| `events` | id, project_id, issue_id, event_id, timestamp, message, type, stacktrace (jsonb), environment, release, user (jsonb), request (jsonb), context (jsonb), fingerprint | F3/F4 |
| `issues` | id, project_id, fingerprint, title, type, culprit, status, severity, is_regression, assignee_id, first_release, last_release, first_seen, last_seen, event_count, user_count, resolved_at | F4/F6/F9 |
| `issue_users` | issue_id, user_key (for unique user counting) | F4 |
| `issue_activity` | issue_id, actor, action, data, created_at | F6 |
| `releases` / `environments` | project_id, version / name, first_seen, last_seen, event_count | F9 |
| `alert_rules` | id, project_id, name, conditions (jsonb), severity, escalation_policy_id, enabled | F10 |
| `notification_channels` | id, org_id / user_id, type, config (jsonb) | F11 |
| `schedules`, `schedule_layers`, `schedule_overrides` | rotation definitions | F12 |
| `incidents` | id, issue_id, rule_id, status, severity, triggered_at, acknowledged_by/at, resolved_by/at | F13 |
| `incident_timeline` | incident_id, type, actor, data, created_at | F13 |
| `escalation_policies`, `escalation_levels` | ordered levels, timeout, targets | F14 |

---

## 3. Features & Implementation Steps

Each feature has: **Goal**, **Requirements** (from the product spec), **Implementation steps** (checklist), and **Acceptance criteria**.

---

### F0 — Project Setup
**Status:** ✅ Done

**Goal:** A runnable skeleton everything else builds on.

**Implementation steps**
- [x] Initialize pnpm workspace (`apps/api`, `apps/web`, `packages/shared`, `packages/sdk-js`)
- [x] `.gitignore` (dependencies, build output, secrets, editor files)
- [x] Root TypeScript config (`tsconfig.base.json`) + `.editorconfig`
- [x] Biome (lint + format)
- [x] `docker-compose.yml` with PostgreSQL and Redis (named volumes, healthchecks)
- [x] `apps/api`: Fastify server, env config loaded + validated with Zod (`.env.example`)
- [x] Drizzle setup: DB client, migration folder, `db:generate` / `db:migrate` / `db:studio` scripts
- [x] Redis connection (ioredis) — *BullMQ worker moved to F3, where it has real work*
- [x] `GET /health` → reports API, Postgres, Redis status (503 when degraded) + graceful shutdown
- [x] Structured logging (pino) and central error handler
- [x] Vitest setup with a test DB; first test for `/health`
- [x] `apps/web`: Vite + React scaffold that loads
- [x] README with setup/run commands; root scripts (`dev`, `test`, `lint`)

**Acceptance criteria**
- `docker compose up -d` + `pnpm dev` starts API and web.
- `GET /health` returns `{ status: "ok", db: "ok", redis: "ok" }`.
- `pnpm test` passes.

---

### F1 — Auth & Users
**Status:** ✅ Done

**Goal:** People can create accounts and log in to the dashboard.

**Implementation steps**
- [x] `users` and `sessions` tables + migration
- [x] Password hashing (argon2)
- [x] `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- [x] Session cookie (httpOnly, secure in prod, SameSite=Lax) with DB-backed sessions
- [x] `requireAuth` Fastify hook/decorator exposing `request.user`
- [x] Input validation (email format, password min length) and consistent error format
- [x] Rate limiting on login/signup
- [x] Tests: signup, duplicate email, login success/failure, protected route, logout

**Acceptance criteria**
- A user can sign up, log in, call `/auth/me`, and log out.
- Protected routes return 401 without a valid session.

---

### F2 — Organizations, Projects & Roles
**Status:** ✅ Done

**Requirements:** Multiple organizations; each contains multiple projects; each project represents one application with its own error data; role-based access; applications identify themselves when reporting.

**Implementation steps**
- [x] `organizations`, `memberships`, `projects`, `project_keys` tables
- [x] Creating a user's first org on signup (user becomes Owner)
- [x] Org endpoints: create, list mine, get, update, invite/add member, change role, remove member
- [x] Project endpoints: create, list (per org), get, update, delete
- [x] Project key (DSN) generation on project creation; rotate/revoke key endpoint
- [x] DSN format, e.g. `http://<public_key>@<host>/<project_id>`
- [x] Authorization helper: `requireOrgRole(orgId, minRole)`; project access resolves via its org
- [x] Tests: role enforcement (Member can't create project, Admin can, etc.), cross-org isolation

**Acceptance criteria**
- Users only see orgs/projects they belong to.
- Each project has a working DSN; revoked keys are rejected (verified in F3).

---

### F3 — Event Ingestion API
**Status:** ✅ Done

**Requirements:** Applications send errors/exceptions. Each event records message, exception type, stack trace, timestamp, environment, release, affected user, request/route info, and extra context. Events are organized by project.

**Implementation steps**
- [x] Shared event schema in `packages/shared` (Zod): `event_id`, `timestamp`, `level`, `message`, `exception { type, value, stacktrace { frames[] } }`, `environment`, `release`, `user { id, email, username, ip }`, `request { method, url, route, headers }`, `tags`, `context`, `sdk { name, version }`
- [x] `POST /api/:projectId/events` authenticated by project public key (header `X-Pulse-Key` or DSN auth)
- [x] Validate payload, apply defaults (timestamp, environment = `production`), enforce size limit
- [x] BullMQ setup: `events` queue + separate worker process (`pnpm worker`)
- [x] Enqueue raw event onto `events` BullMQ queue; respond `202 { id }` immediately
- [x] `events` table + migration (issue_id nullable until F4)
- [x] Event worker: consume queue and persist event
- [x] CORS support so browser apps can report
- [x] Idempotency: ignore duplicate `event_id` per project
- [x] Tests: valid event stored, invalid key → 401, revoked key → 401, bad payload → 400, duplicate ignored

**Acceptance criteria**
- `curl` with a valid key stores an event in Postgres with all fields.
- Endpoint responds fast (queue-backed) and rejects bad/unauthenticated input.

---

### F4 — Fingerprinting & Grouping
**Status:** ✅ Done

**Requirements:** Similar errors grouped into one issue via a fingerprint; thousands of identical events become one issue; each issue keeps its event history, event count, first/last seen, affected users; resolved issues reopen when the problem returns.

**Implementation steps**
- [x] Fingerprint algorithm (in order of preference):
  1. Client-provided `fingerprint` array, if present
  2. Exception type + normalized in-app stack frames (function + module/filename, **no** line numbers)
  3. Fallback: exception type + normalized message (strip numbers, UUIDs, hex, quoted strings)
- [x] Hash with SHA-256 → `fingerprint`
- [x] `issues` and `issue_users` tables + migration
- [x] Worker: upsert issue by `(project_id, fingerprint)` in a transaction; set title/culprit on create
- [x] Update `last_seen`, increment `event_count`; insert into `issue_users` and update `user_count` when a new user key appears (user.id → email → ip)
- [x] Link event → issue
- [x] Regression: if issue is `resolved` and a new event arrives → set `unresolved`, flag `is_regression`, record activity
- [x] Tests: identical errors → 1 issue; different line numbers same function → 1 issue; different types → 2 issues; user counting; regression reopen

**Acceptance criteria**
- Sending the same error 1000× creates exactly one issue with `event_count = 1000`.
- Resolving then re-sending reopens the issue as a regression.

---

### F5 — JS/Node SDK
**Status:** ✅ Done

**Requirements:** Applications can report errors to Pulse and identify themselves.

**Implementation steps**
- [x] `Pulse.init({ dsn, environment, release, sampleRate, beforeSend })`
- [x] `captureException(err, context?)`, `captureMessage(msg, level?)`
- [x] `setUser()`, `setTag()`, `setContext()` scope API
- [x] Stack trace parsing (V8/Node + browser formats) into frames; mark in-app frames
- [x] Node: global `uncaughtException` / `unhandledRejection` handlers
- [x] Browser: `window.onerror` / `unhandledrejection` handlers
- [x] Express/Fastify middleware to attach request info (method, url, route)
- [x] Transport: `fetch` with retry/backoff, non-blocking, `flush()` before exit
- [x] Build (ESM + CJS) with tsup (+ `tsc` for `.d.ts`, since TypeScript 7 has no JS API for tsup's dts); example app in `examples/node-app` that throws errors
- [x] Tests: payload shape, stack parsing, beforeSend filtering, sampling

**Acceptance criteria**
- Example app throws → issue appears in Pulse with stack, release, environment, user, route.

---

### F6 — Issue Management API
**Status:** ✅ Done

**Requirements:** Issues have severity and status (open/resolved); developers see first/last seen, frequency, affected users, environments, releases, stack, events, and history; can mark resolved.

**Implementation steps**
- [x] `GET /projects/:id/issues` — cursor pagination, sort (last_seen, first_seen, event_count, user_count), `status` filter
- [x] `GET /issues/:id` — details + latest event + env/release breakdown
- [x] `GET /issues/:id/events` — paginated event list; `GET /events/:id` — full event
- [x] `PATCH /issues/:id` — status (`unresolved` / `resolved` / `ignored`), severity (`low` / `medium` / `high` / `critical`), assignee
- [x] Bulk update endpoint (resolve many): `PATCH /projects/:id/issues { ids, ...changes }`
- [x] `issue_activity` table (created in F4, already records regressions): record status/severity/assignee changes
- [x] `GET /issues/:id/activity` — issue history
- [x] Default severity derived from event level; manual override persists
- [x] Tests: permissions, filtering by project, status transitions, activity logging

**Acceptance criteria**
- Every issue detail listed in the spec is available via the API.

---

### F7 — Dashboard UI
**Status:** ✅ Done

**Requirements:** Central dashboard for application health: active issues, critical issues, event counts, affected users, recent and frequent problems; open an issue to see details.

**Implementation steps**
- [x] App shell: routing (React Router), data fetching (TanStack Query), API client, auth guard
- [x] Pages: Login, Signup
- [x] Org/project switcher; project settings page showing DSN + setup snippet
- [x] Overview page: stat cards (active issues, critical issues, events 24h, affected users 24h), "Recent issues" and "Most frequent issues" lists
- [x] Issues list: title, culprit, status/severity badges, events, users, last seen
- [x] Issue detail: header stats, stack trace viewer (collapsible frames, in-app highlight), tags/context, request, user, event navigator (prev/next), activity history
- [x] Actions: resolve / ignore / reopen, change severity
- [x] Empty states, loading states, error states
- [x] Tests: key component tests (Vitest + Testing Library, fake API) + one end-to-end smoke flow (Playwright in the local Chrome: `pnpm e2e`)

**Acceptance criteria**
- A developer can log in, pick a project, see its health at a glance, open an issue, and resolve it.

---

### F8 — Search & Investigation
**Status:** ✅ Done: merged into `main`

**Requirements:** Search issues and error messages; filter by environment, project, severity, status; examine historical occurrences; see frequency over time.

**Implementation steps**
- [x] Full-text search on issue title/message (Postgres `tsvector` + GIN index, trigram fallback): `?q=` on issue lists
- [x] Filters on issues list: `status`, `severity`, `environment`, `release`, `project`, date range (`since`/`until`): comma lists, combinable; `project` via `GET /orgs/:orgId/issues?project=…`
- [x] Filters encoded in URL query string (shareable links): `?q=&severity=&environment=&release=&period=` on the issues page; `period` becomes a `since` date when the request is sent
- [x] Event search within an issue (by user, release, environment, tag): `GET /issues/:id/events?user=&release=&environment=&tag=key:value`
- [x] Time-series endpoint: event counts per hour/day for an issue and for a project: `GET /projects/:id/timeseries`, `GET /issues/:id/timeseries` (`period`, `interval`, `environment`; empty buckets = 0)
- [x] Frequency charts on overview and issue detail: `FrequencyChart.tsx` (hover/keyboard readout, hidden table for screen readers; buckets are UTC)
- [x] DB indexes for common filter combinations: migration `0005` (`pg_trgm`, search GIN, title trigram, issues `(project_id, status, last_seen)`, events `(issue_id, environment)` / `(issue_id, release)`)
- [x] Tests: each filter, combined filters, search relevance, time buckets: `test/search.test.ts` (23 tests), plus web tests `FrequencyChart.test.tsx` and `IssuesPage.test.tsx` (10 tests)

**Acceptance criteria**
- A developer can find a specific error message and narrow issues by any listed dimension within seconds.

---

### F9 — Releases, Environments & User Impact
**Status:** ✅ Done: merged into `main`

**Requirements:** Track release per error; identify newly introduced failures; compare releases; separate environments; show how many users are affected and highlight broad-impact issues.

**Implementation steps**
- [x] `releases` and `environments` tables, auto-created from incoming events (migration `0006` also backfills older events)
- [x] Record `first_release` / `last_release` on issues
- [x] Releases page: list releases, events/issues per release, "new issues in this release"
- [x] Release comparison view (issues present in A vs B)
- [x] Global environment selector in dashboard (defaults to `production` when the project has it, else all environments; remembered per project)
- [x] User impact: affected-users column + sort, "% of users affected" where total is known (`totalUsers` in `/stats`), "high impact" badge (≥10% of users and ≥3 users)
- [x] Issue detail: per-environment and per-release breakdown
- [x] Tests: release auto-creation, new-in-release query, environment isolation

**Acceptance criteria**
- A developer can answer "which release introduced this?" and "how many users does this affect?" from the UI.

---

### F10 — Alert Rules
**Status:** ✅ Done: merged into `main` (code bundled into the F9 commits, env-filter fix in `9aa4c2f`)

**Requirements:** Teams define which problems trigger alerts; critical issues trigger immediate notification; rules connected to projects; alerts associated with issues; alerting converts problems into incidents.

**Implementation steps**
- [x] `alert_rules` table: project, name, enabled, environment filter, conditions, action (create incident with severity + escalation policy). The `escalation_policy_id` column exists but can't be set until F14 adds the policies table
- [x] Condition types:
  - new issue created
  - issue regressed
  - issue severity is `critical`
  - more than **N events** in **X minutes**
  - more than **N unique users** affected
- [x] Rule evaluation step in event worker after grouping (Redis counters for rate windows)
- [x] De-duplication: don't create a new incident while one is open for the same issue + rule; cooldown period
- [x] CRUD endpoints + UI (rule builder form): its own **Alerts** page, linked from project settings
- [x] Rule "test" button that previews matches against recent issues
- [x] Tests: each condition, dedup/cooldown, environment filter

**Known limitations**
- An environment-filtered "regression" rule misses an issue that regresses in another environment first ("new issue" handles this: it fires on the first event in the rule's environment)
- The Redis window keeps every event of the last 24 h per issue; revisit memory use in F15

**Acceptance criteria**
- A matching error creates exactly one incident linked to its issue and rule.

---

### F11 — Notification Channels
**Status:** 🔄 In progress: backend work started on `dev` (uncommitted)

**Requirements:** Notify responsible people via email, SMS, push, and webhooks; notifications include issue, application, severity, and investigation info.

**Implementation steps**
- [x] `Notifier` interface: `send(recipient, payload)`; channel registry
- [x] `notifications` queue + worker with retries and delivery log (`notification_log`)
- [x] Email channel (SMTP via nodemailer; Mailpit in Docker Compose for local testing)
- [x] Webhook channel (JSON POST, HMAC signature header, retries)
- [x] SMS channel (Twilio adapter, disabled unless configured)
- [x] Push channel (Web Push / VAPID for the dashboard)
- [x] User contact methods + notification preferences (per-user settings page)
- [x] Message templates: project, issue title, severity, event count, users affected, link to issue, **acknowledge link**
- [x] Tests: template rendering, channel selection, retry on failure, webhook signature

**Acceptance criteria**
- An incident produces an email in Mailpit and a webhook POST containing all required info. ✅ checked by hand on 2026-10-22 (API + worker + Mailpit + a local webhook receiver)

**How it was built** (`apps/api/src/notifications/`)
- Tables (migration `0008`): `notification_channels` (owner = a user *or* an org, enforced by a CHECK; `config` JSONB per type; `min_severity` preference compared in enum order) and `notification_log` (unique `(incident, channel, trigger)` so a retried job never notifies twice). Backfill + signup: every user gets their account email as a channel.
- Flow: event worker commits → enqueues an `incident` job → `planIncidentNotifications` writes one pending log row per channel → one `deliver` job per row (6 attempts, exponential backoff from 5s). `PermanentError` = no retry (4xx, bad number); dead push subscriptions turn their channel off. Deliveries for an incident that is no longer `triggered` are skipped.
- Who is notified (until F12/F14): the org's team channels + every member's own channels whose `min_severity` ≤ incident severity.
- Webhook: headers `X-Pulse-Delivery`, `X-Pulse-Timestamp`, `X-Pulse-Signature: sha256=HMAC(secret, "timestamp.body")`; secret `whsec_…` shown once; 10s timeout, no redirects.
- Acknowledge link: `WEB_PUBLIC_URL/incidents/:id/acknowledge?token=…`, an HMAC token (APP_SECRET) per recipient, valid 7 days. **The page/endpoint that uses it comes in F13.**
- API: `/me/notification-channels` (+ `/:id/test`), `/me/notifications`, `/orgs/:orgId/notification-channels` (admin to change), `/orgs/:orgId/notifications` (delivery log). Test button: 5 per 10 min per channel.
- Web: Notifications page (contact methods, preferences, push button, team channels, delivery log), `public/sw.js` service worker.
- New env: `WEB_PUBLIC_URL`, `APP_SECRET` (required in production), `SMTP_*`, `TWILIO_*`, `VAPID_*` (see `.env.example`). Mailpit inbox: http://localhost:8025.

**Known gaps:** if enqueueing fails *after* the event transaction commits, that incident isn't notified (an outbox/sweeper would fix it, F15); webhook URLs aren't checked against private IPs (SSRF hardening, F15); SMS/push are untested against the real Twilio/push services; per-user quiet hours not done.

---

### F12 — On-Call Schedules
**Status:** ⬜ Not started

**Requirements:** Define who is responsible; different people for different periods; current on-call is the first responder; ordered responder list.

**Implementation steps**
- [ ] `schedules` (org, name, timezone), `schedule_layers` (rotation type daily/weekly/custom, handoff time, ordered participants), `schedule_overrides` (user, start, end)
- [ ] Resolver: `getOnCall(scheduleId, at)` → user (overrides win over layers)
- [ ] Endpoints: CRUD schedules/layers/overrides, `GET /schedules/:id/oncall?at=`
- [ ] UI: schedule editor, calendar/timeline of upcoming shifts, "who's on call now" widget
- [ ] Tests: rotation math across handoffs, timezones/DST, overrides

**Acceptance criteria**
- For any timestamp, Pulse returns exactly one on-call user per schedule.

---

### F13 — Incidents & Acknowledgement
**Status:** ⬜ Not started

**Requirements:** Incident begins on significant problem, tied to an issue; responder notified; responder acknowledges (takes responsibility, state recorded, prevents duplicate response); unacknowledged incidents remain eligible for escalation; incidents resolved; history kept.

**Implementation steps**
- [ ] `incidents` table: status `triggered` → `acknowledged` → `resolved`; `incident_timeline` table
- [ ] On incident creation: resolve first responder (on-call) → send notification → timeline entry
- [ ] `POST /incidents/:id/acknowledge` and `/resolve` (dashboard + signed one-click link from notifications)
- [ ] Guard: only one acknowledgement; second attempt returns who already acknowledged
- [ ] Resolving an incident optionally resolves the issue
- [ ] Incidents list + detail UI (timeline: triggered, notified, acknowledged, escalated, resolved)
- [ ] Tests: lifecycle transitions, invalid transitions rejected, signed link auth, timeline completeness

**Acceptance criteria**
- A responder can acknowledge from an email link; the dashboard shows who acknowledged and when.

---

### F14 — Escalation Policies
**Status:** ⬜ Not started

**Requirements:** Escalate when nobody responds; first responder gets initial notification; wait a defined period; move to next responder; continue through multiple levels; stop on acknowledgement; record escalation history.

**Implementation steps**
- [ ] `escalation_policies` + `escalation_levels` (order, timeout minutes, targets: users and/or schedules)
- [ ] Optional "repeat policy N times" when last level is reached
- [ ] On incident trigger: notify level 1, schedule delayed BullMQ job for `timeout`
- [ ] Escalation job: if incident still `triggered` → notify next level, record timeline, schedule next job; else no-op
- [ ] Acknowledge/resolve cancels pending escalation jobs
- [ ] Link policies to alert rules (F10)
- [ ] UI: policy editor (drag to reorder levels), escalation history on incident timeline
- [ ] Tests: escalation happens after timeout (fake timers), stops on ack, repeat behavior, schedule targets resolve to on-call user

**Acceptance criteria**
- An unacknowledged incident walks through every level on time; acknowledging stops it immediately; history shows who was contacted.

---

### F15 — Hardening & Deployment
**Status:** ⬜ Not started

**Goal:** Make Pulse safe and practical to self-host.

**Implementation steps**
- [ ] Per-project ingestion rate limits and quota (Redis)
- [ ] Data retention job (delete events older than N days per project)
- [ ] Audit log for sensitive actions (members, keys, rules, policies)
- [ ] PII scrubbing options (strip passwords/tokens/cookies from payloads)
- [ ] Move to hosted Postgres (e.g. Neon) and hosted Redis — only `DATABASE_URL` / `REDIS_URL` change; run migrations against the new DB
- [ ] Production Dockerfiles + `docker-compose.prod.yml` (api, worker, web)
- [ ] Load test ingestion (autocannon/k6) and tune indexes
- [ ] Docs: self-hosting guide, SDK guide, API reference
- [ ] CI pipeline (lint, typecheck, test)

**Acceptance criteria**
- A fresh machine can run Pulse with one compose command, following the README.

---

## 4. Out of Scope (for now)
- Source map upload / symbolication
- Performance monitoring / tracing
- SDKs for languages other than JavaScript/TypeScript
- SSO / SAML
- Billing / multi-tenant SaaS hosting

---

## 5. Changelog
| Date | Feature | Notes |
|---|---|---|
| 2026-09-27 | — | PRD created, stack chosen (TypeScript end-to-end) |
| 2026-09-28 | F0 | Started on branch `dev`: pnpm monorepo skeleton, `.gitignore` |
| 2026-09-28 | F0 | TypeScript base config, `.editorconfig`, Docker Compose with Postgres + Redis |
| 2026-09-28 | F0 | `@pulse/api` package: Fastify server, env validation, `GET /health` |
| 2026-09-28 | F0 | Postgres (Drizzle) + Redis connections, health checks, graceful shutdown; BullMQ worker moved to F3 |
