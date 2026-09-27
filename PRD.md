# Pulse — Product Requirements & Build Tracker

> Self-hosted application error tracking and incident response platform.
> **Detect → Group → Understand → Alert → Acknowledge → Escalate → Resolve**

This file is the single source of truth for **what Pulse is**, **how each feature is built**, and **where we are right now**. We build **one feature at a time, in order**. A feature is only marked done after it is implemented, tested, and reviewed.

---

## 📍 Current Position

| | |
|---|---|
| **Current feature** | F0 — Project Setup |
| **Status** | 🔄 In progress (5 of 13 steps done) |
| **Working branch** | `dev` |
| **Last completed** | Lesson 4 — Fastify server, Zod env validation, `GET /health` (API only) |
| **Next step** | Lesson 5 — connect Postgres (Drizzle) + Redis (BullMQ); `/health` reports db + redis |
| **Next feature** | F1 — Auth & Users |

### Learning Log
| Lesson | Topic | Status |
|---|---|---|
| 1 | Git basics: add → commit → push, first push of PRD | ✅ |
| 2 | Tools (Node, pnpm, TS, Docker), branches, monorepo, `package.json`, `pnpm-workspace.yaml`, `.gitignore`, secrets & `.env` | ✅ |
| 3 | TypeScript config, `.editorconfig`, Docker Compose (images, containers, volumes, healthchecks), `.env` usage | ✅ |
| 4 | Servers, routes, requests/responses, JSON, ports; Fastify + Zod env validation + `/health` | ✅ |
| 5 | Database (Drizzle) + Redis/BullMQ connection | ⬜ |
| 6 | Logging, error handler, first test (Vitest) | ⬜ |
| 7 | Web app scaffold (Vite + React), README, root scripts → merge F0 into `main` | ⬜ |

### Progress Tracker

Legend: ⬜ Not started · 🔄 In progress · 👀 In review · ✅ Done

| # | Feature | Phase | Status |
|---|---|---|---|
| F0 | Project Setup | A — Foundation | 🔄 |
| F1 | Auth & Users | A — Foundation | ⬜ |
| F2 | Organizations, Projects & Roles | A — Foundation | ⬜ |
| F3 | Event Ingestion API | B — Error Tracking | ⬜ |
| F4 | Fingerprinting & Grouping | B — Error Tracking | ⬜ |
| F5 | JS/Node SDK | B — Error Tracking | ⬜ |
| F6 | Issue Management API | B — Error Tracking | ⬜ |
| F7 | Dashboard UI | B — Error Tracking | ⬜ |
| F8 | Search & Investigation | B — Error Tracking | ⬜ |
| F9 | Releases, Environments & User Impact | B — Error Tracking | ⬜ |
| F10 | Alert Rules | C — Incident Response | ⬜ |
| F11 | Notification Channels | C — Incident Response | ⬜ |
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
│   └── sdk-js/         # Client SDK
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
| `issues` | id, project_id, fingerprint, title, type, culprit, status, severity, first_seen, last_seen, event_count, user_count | F4 |
| `issue_users` | issue_id, user_key (for unique user counting) | F4 |
| `issue_activity` | issue_id, actor, action, data, created_at | F6 |
| `releases` / `environments` | project_id, name, first_seen | F9 |
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
**Status:** 🔄 In progress

**Goal:** A runnable skeleton everything else builds on.

**Implementation steps**
- [x] Initialize pnpm workspace (`apps/api`, `apps/web`, `packages/shared`, `packages/sdk-js`)
- [x] `.gitignore` (dependencies, build output, secrets, editor files)
- [x] Root TypeScript config (`tsconfig.base.json`) + `.editorconfig`
- [ ] ESLint + Prettier
- [x] `docker-compose.yml` with PostgreSQL and Redis (named volumes, healthchecks)
- [x] `apps/api`: Fastify server, env config loaded + validated with Zod (`.env.example`)
- [ ] Drizzle setup: DB client, migration folder, `db:generate` / `db:migrate` scripts
- [ ] Redis connection + BullMQ bootstrap (empty worker process)
- [ ] `GET /health` → reports API, Postgres, Redis status
- [ ] Structured logging (pino) and central error handler
- [ ] Vitest setup with a test DB; first test for `/health`
- [ ] `apps/web`: Vite + React scaffold that loads
- [ ] README with setup/run commands; root scripts (`dev`, `test`, `lint`)

**Acceptance criteria**
- `docker compose up -d` + `pnpm dev` starts API and web.
- `GET /health` returns `{ status: "ok", db: "ok", redis: "ok" }`.
- `pnpm test` passes.

---

### F1 — Auth & Users
**Status:** ⬜ Not started

**Goal:** People can create accounts and log in to the dashboard.

**Implementation steps**
- [ ] `users` and `sessions` tables + migration
- [ ] Password hashing (argon2)
- [ ] `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- [ ] Session cookie (httpOnly, secure in prod, SameSite=Lax) with DB-backed sessions
- [ ] `requireAuth` Fastify hook/decorator exposing `request.user`
- [ ] Input validation (email format, password min length) and consistent error format
- [ ] Rate limiting on login/signup
- [ ] Tests: signup, duplicate email, login success/failure, protected route, logout

**Acceptance criteria**
- A user can sign up, log in, call `/auth/me`, and log out.
- Protected routes return 401 without a valid session.

---

### F2 — Organizations, Projects & Roles
**Status:** ⬜ Not started

**Requirements:** Multiple organizations; each contains multiple projects; each project represents one application with its own error data; role-based access; applications identify themselves when reporting.

**Implementation steps**
- [ ] `organizations`, `memberships`, `projects`, `project_keys` tables
- [ ] Creating a user's first org on signup (user becomes Owner)
- [ ] Org endpoints: create, list mine, get, update, invite/add member, change role, remove member
- [ ] Project endpoints: create, list (per org), get, update, delete
- [ ] Project key (DSN) generation on project creation; rotate/revoke key endpoint
- [ ] DSN format, e.g. `http://<public_key>@<host>/<project_id>`
- [ ] Authorization helper: `requireOrgRole(orgId, minRole)`; project access resolves via its org
- [ ] Tests: role enforcement (Member can't create project, Admin can, etc.), cross-org isolation

**Acceptance criteria**
- Users only see orgs/projects they belong to.
- Each project has a working DSN; revoked keys are rejected (verified in F3).

---

### F3 — Event Ingestion API
**Status:** ⬜ Not started

**Requirements:** Applications send errors/exceptions. Each event records message, exception type, stack trace, timestamp, environment, release, affected user, request/route info, and extra context. Events are organized by project.

**Implementation steps**
- [ ] Shared event schema in `packages/shared` (Zod): `event_id`, `timestamp`, `level`, `message`, `exception { type, value, stacktrace { frames[] } }`, `environment`, `release`, `user { id, email, username, ip }`, `request { method, url, route, headers }`, `tags`, `context`, `sdk { name, version }`
- [ ] `POST /api/:projectId/events` authenticated by project public key (header `X-Pulse-Key` or DSN auth)
- [ ] Validate payload, apply defaults (timestamp, environment = `production`), enforce size limit
- [ ] Enqueue raw event onto `events` BullMQ queue; respond `202 { id }` immediately
- [ ] `events` table + migration (issue_id nullable until F4)
- [ ] Event worker: consume queue and persist event
- [ ] CORS support so browser apps can report
- [ ] Idempotency: ignore duplicate `event_id` per project
- [ ] Tests: valid event stored, invalid key → 401, revoked key → 401, bad payload → 400, duplicate ignored

**Acceptance criteria**
- `curl` with a valid key stores an event in Postgres with all fields.
- Endpoint responds fast (queue-backed) and rejects bad/unauthenticated input.

---

### F4 — Fingerprinting & Grouping
**Status:** ⬜ Not started

**Requirements:** Similar errors grouped into one issue via a fingerprint; thousands of identical events become one issue; each issue keeps its event history, event count, first/last seen, affected users; resolved issues reopen when the problem returns.

**Implementation steps**
- [ ] Fingerprint algorithm (in order of preference):
  1. Client-provided `fingerprint` array, if present
  2. Exception type + normalized in-app stack frames (function + module/filename, **no** line numbers)
  3. Fallback: exception type + normalized message (strip numbers, UUIDs, hex, quoted strings)
- [ ] Hash with SHA-256 → `fingerprint`
- [ ] `issues` and `issue_users` tables + migration
- [ ] Worker: upsert issue by `(project_id, fingerprint)` in a transaction; set title/culprit on create
- [ ] Update `last_seen`, increment `event_count`; insert into `issue_users` and update `user_count` when a new user key appears (user.id → email → ip)
- [ ] Link event → issue
- [ ] Regression: if issue is `resolved` and a new event arrives → set `unresolved`, flag `is_regression`, record activity
- [ ] Tests: identical errors → 1 issue; different line numbers same function → 1 issue; different types → 2 issues; user counting; regression reopen

**Acceptance criteria**
- Sending the same error 1000× creates exactly one issue with `event_count = 1000`.
- Resolving then re-sending reopens the issue as a regression.

---

### F5 — JS/Node SDK
**Status:** ⬜ Not started

**Requirements:** Applications can report errors to Pulse and identify themselves.

**Implementation steps**
- [ ] `Pulse.init({ dsn, environment, release, sampleRate, beforeSend })`
- [ ] `captureException(err, context?)`, `captureMessage(msg, level?)`
- [ ] `setUser()`, `setTag()`, `setContext()` scope API
- [ ] Stack trace parsing (V8/Node + browser formats) into frames; mark in-app frames
- [ ] Node: global `uncaughtException` / `unhandledRejection` handlers
- [ ] Browser: `window.onerror` / `unhandledrejection` handlers
- [ ] Express/Fastify middleware to attach request info (method, url, route)
- [ ] Transport: `fetch` with retry/backoff, non-blocking, `flush()` before exit
- [ ] Build (ESM + CJS) with tsup; example app in `examples/` that throws errors
- [ ] Tests: payload shape, stack parsing, beforeSend filtering, sampling

**Acceptance criteria**
- Example app throws → issue appears in Pulse with stack, release, environment, user, route.

---

### F6 — Issue Management API
**Status:** ⬜ Not started

**Requirements:** Issues have severity and status (open/resolved); developers see first/last seen, frequency, affected users, environments, releases, stack, events, and history; can mark resolved.

**Implementation steps**
- [ ] `GET /projects/:id/issues` — pagination, sort (last_seen, first_seen, event_count, user_count)
- [ ] `GET /issues/:id` — details + latest event + env/release breakdown
- [ ] `GET /issues/:id/events` — paginated event list; `GET /events/:id` — full event
- [ ] `PATCH /issues/:id` — status (`unresolved` / `resolved` / `ignored`), severity (`low` / `medium` / `high` / `critical`), assignee
- [ ] Bulk update endpoint (resolve many)
- [ ] `issue_activity` table: record status/severity/assignee changes and regressions
- [ ] `GET /issues/:id/activity` — issue history
- [ ] Default severity derived from event level; manual override persists
- [ ] Tests: permissions, filtering by project, status transitions, activity logging

**Acceptance criteria**
- Every issue detail listed in the spec is available via the API.

---

### F7 — Dashboard UI
**Status:** ⬜ Not started

**Requirements:** Central dashboard for application health: active issues, critical issues, event counts, affected users, recent and frequent problems; open an issue to see details.

**Implementation steps**
- [ ] App shell: routing (React Router), data fetching (TanStack Query), API client, auth guard
- [ ] Pages: Login, Signup
- [ ] Org/project switcher; project settings page showing DSN + setup snippet
- [ ] Overview page: stat cards (active issues, critical issues, events 24h, affected users 24h), "Recent issues" and "Most frequent issues" lists
- [ ] Issues list: title, culprit, status/severity badges, events, users, last seen
- [ ] Issue detail: header stats, stack trace viewer (collapsible frames, in-app highlight), tags/context, request, user, event navigator (prev/next), activity history
- [ ] Actions: resolve / ignore / reopen, change severity
- [ ] Empty states, loading states, error states
- [ ] Tests: key component tests + one end-to-end smoke flow

**Acceptance criteria**
- A developer can log in, pick a project, see its health at a glance, open an issue, and resolve it.

---

### F8 — Search & Investigation
**Status:** ⬜ Not started

**Requirements:** Search issues and error messages; filter by environment, project, severity, status; examine historical occurrences; see frequency over time.

**Implementation steps**
- [ ] Full-text search on issue title/message (Postgres `tsvector` + GIN index, trigram fallback)
- [ ] Filters on issues list: `status`, `severity`, `environment`, `release`, `project`, date range
- [ ] Filters encoded in URL query string (shareable links)
- [ ] Event search within an issue (by user, release, environment, tag)
- [ ] Time-series endpoint: event counts per hour/day for an issue and for a project
- [ ] Frequency charts on overview and issue detail
- [ ] DB indexes for common filter combinations
- [ ] Tests: each filter, combined filters, search relevance, time buckets

**Acceptance criteria**
- A developer can find a specific error message and narrow issues by any listed dimension within seconds.

---

### F9 — Releases, Environments & User Impact
**Status:** ⬜ Not started

**Requirements:** Track release per error; identify newly introduced failures; compare releases; separate environments; show how many users are affected and highlight broad-impact issues.

**Implementation steps**
- [ ] `releases` and `environments` tables, auto-created from incoming events
- [ ] Record `first_release` / `last_release` on issues
- [ ] Releases page: list releases, events/issues per release, "new issues in this release"
- [ ] Release comparison view (issues present in A vs B)
- [ ] Global environment selector in dashboard (defaults to `production`)
- [ ] User impact: affected-users column + sort, "% of users affected" where total is known, "high impact" badge
- [ ] Issue detail: per-environment and per-release breakdown
- [ ] Tests: release auto-creation, new-in-release query, environment isolation

**Acceptance criteria**
- A developer can answer "which release introduced this?" and "how many users does this affect?" from the UI.

---

### F10 — Alert Rules
**Status:** ⬜ Not started

**Requirements:** Teams define which problems trigger alerts; critical issues trigger immediate notification; rules connected to projects; alerts associated with issues; alerting converts problems into incidents.

**Implementation steps**
- [ ] `alert_rules` table: project, name, enabled, environment filter, conditions, action (create incident with severity + escalation policy)
- [ ] Condition types:
  - new issue created
  - issue regressed
  - issue severity is `critical`
  - more than **N events** in **X minutes**
  - more than **N unique users** affected
- [ ] Rule evaluation step in event worker after grouping (Redis counters for rate windows)
- [ ] De-duplication: don't create a new incident while one is open for the same issue + rule; cooldown period
- [ ] CRUD endpoints + UI (rule builder form) in project settings
- [ ] Rule "test" button that previews matches against recent issues
- [ ] Tests: each condition, dedup/cooldown, environment filter

**Acceptance criteria**
- A matching error creates exactly one incident linked to its issue and rule.

---

### F11 — Notification Channels
**Status:** ⬜ Not started

**Requirements:** Notify responsible people via email, SMS, push, and webhooks; notifications include issue, application, severity, and investigation info.

**Implementation steps**
- [ ] `Notifier` interface: `send(recipient, payload)`; channel registry
- [ ] `notifications` queue + worker with retries and delivery log (`notification_log`)
- [ ] Email channel (SMTP via nodemailer; Mailpit in Docker Compose for local testing)
- [ ] Webhook channel (JSON POST, HMAC signature header, retries)
- [ ] SMS channel (Twilio adapter, disabled unless configured)
- [ ] Push channel (Web Push / VAPID for the dashboard)
- [ ] User contact methods + notification preferences (per-user settings page)
- [ ] Message templates: project, issue title, severity, event count, users affected, link to issue, **acknowledge link**
- [ ] Tests: template rendering, channel selection, retry on failure, webhook signature

**Acceptance criteria**
- An incident produces an email in Mailpit and a webhook POST containing all required info.

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
- [ ] Production Dockerfiles + `docker-compose.prod.yml` (api, worker, web, postgres, redis)
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
