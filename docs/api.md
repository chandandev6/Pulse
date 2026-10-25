# Pulse API reference

The dashboard uses this same API. Behind the production nginx it is served under `/backend`
(`https://pulse.example.com/backend/orgs`). In development, call the API port directly
(`http://localhost:3000/orgs`).

## Conventions

- **JSON** in and out. Send `content-type: application/json`.
- **Auth.** `POST /auth/login` sets an httpOnly `pulse_session` cookie. A session ends after 7
  days without use, and after 30 days at most. Send it with every request. Ingestion is the exception: it uses the project's public key instead.
- **Roles.** Every org member has a role: `owner` > `admin` > `member`. The tables below show the
  lowest role allowed. If you're not a member, the answer is `404`, so outsiders can't tell that
  something exists. If your role is too low, the answer is `403`.
- **Errors** always look like `{ "error": { "code": "SLUG_TAKEN", "message": "…" } }`.
  Common codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403),
  `*_NOT_FOUND` (404), `RATE_LIMITED` / `PROJECT_RATE_LIMITED` / `QUOTA_EXCEEDED` (429, with
  `Retry-After`).
- **Pagination.** Lists that can grow take `?limit=` (1–100, default 25) and `?cursor=`. They
  return `nextCursor`, which is `null` on the last page. Pass it back unchanged to get the next page.

## Ingestion

| Method | Path                         | Auth                                   |
| ------ | ---------------------------- | -------------------------------------- |
| POST   | `/api/:projectId/events`     | `X-Pulse-Key` header (or `?pulse_key=`) |

The body is described in the [SDK guide](../packages/sdk-js/README.md#event-format).
Answers: `202 { id }`, `400`, `401`, `413` (more than 200 KB), `429`. CORS is open, so browsers
can send events from any site.

## Auth

| Method | Path            | Who     | Notes                                               |
| ------ | --------------- | ------- | --------------------------------------------------- |
| POST   | `/auth/signup`  | anyone  | `{ email, password, name }`. Also creates your first org. 10/hour per IP |
| POST   | `/auth/login`   | anyone  | `{ email, password }`. Sets the cookie. 5 per 15 min per IP+email, and 20 wrong passwords per hour per email from anywhere |
| GET    | `/auth/me`      | signed in | The current user                                  |
| POST   | `/auth/logout`  | anyone  | Deletes the session. `204`                          |
| POST   | `/auth/sessions/sign-out-others` | signed in | Ends every other session of your account. `{ signedOut }` |

## Organizations and members

| Method | Path                              | Who    | Notes                                             |
| ------ | --------------------------------- | ------ | ------------------------------------------------- |
| POST   | `/orgs`                           | signed in | `{ name, slug? }`. You become its owner        |
| GET    | `/orgs`                           | signed in | Orgs you belong to, with your role             |
| GET    | `/orgs/:orgId`                    | member |                                                   |
| PATCH  | `/orgs/:orgId`                    | admin  | `{ name?, slug? }`                                |
| GET    | `/orgs/:orgId/members`            | member |                                                   |
| PATCH  | `/orgs/:orgId/members/:userId`    | admin  | `{ role }`. An org always keeps at least one owner |
| DELETE | `/orgs/:orgId/members/:userId`    | admin, or yourself | Remove someone, or leave              |
| GET    | `/orgs/:orgId/audit-log`          | admin  | `?action=&actorId=&limit=&cursor=`. Newest first  |

Audit actions: `org.updated`, `member.added|role_changed|removed`,
`project.created|updated|deleted`, `key.rotated|revoked`, `alert_rule.*`,
`escalation_policy.*`, `schedule.*`, `channel.*` (each `*` is `created`, `updated` or `deleted`).

## Projects

| Method | Path                                    | Who    | Notes                                       |
| ------ | --------------------------------------- | ------ | ------------------------------------------- |
| POST   | `/orgs/:orgId/projects`                 | admin  | `{ name, slug?, platform? }`. Returns the DSN |
| GET    | `/orgs/:orgId/projects`                 | member |                                             |
| GET    | `/projects/:projectId`                  | member | Project, keys (with DSNs), `usage.eventsThisMonth` |
| PATCH  | `/projects/:projectId`                  | admin  | See below                                   |
| DELETE | `/projects/:projectId`                  | admin  | Deletes all its data                        |
| POST   | `/projects/:projectId/keys/rotate`      | admin  | Revokes every active key, returns a new one |
| POST   | `/projects/:projectId/keys/:keyId/revoke` | admin |                                             |

`PATCH /projects/:projectId` fields (all optional):
`name`, `slug`, `platform`, `onCallScheduleId` (or `null`), `rateLimitPerMinute` (1–100000),
`monthlyQuota` (number or `null` for none), `retentionDays` (1–3650), `scrubData`,
`scrubFields` (up to 50 extra key names), `scrubIpAddresses`.

## Issues and events

| Method | Path                                   | Who    | Notes                                         |
| ------ | -------------------------------------- | ------ | --------------------------------------------- |
| GET    | `/projects/:projectId/issues`          | member | Filters: `q`, `status`, `severity`, `environment`, `release`, `since`, `until`, `sort`; paginated |
| GET    | `/orgs/:orgId/issues`                  | member | The same filters, across every project        |
| PATCH  | `/projects/:projectId/issues`          | member | Bulk update `{ ids, status?, severity?, assigneeId? }` |
| GET    | `/issues/:issueId`                     | member | Issue, latest event, environment/release breakdown |
| PATCH  | `/issues/:issueId`                     | member | `{ status?, severity?, assigneeId? }`         |
| GET    | `/issues/:issueId/events`              | member | The issue's events, paginated                 |
| GET    | `/issues/:issueId/activity`            | member | Status changes, regressions…                  |
| GET    | `/issues/:issueId/timeseries`          | member | `?period=24h\|7d\|14d\|30d\|90d&environment=` |
| GET    | `/events/:eventId`                     | member | One event, with its previous and next event   |
| GET    | `/projects/:projectId/stats`           | member | Overview numbers, `?environment=`             |
| GET    | `/projects/:projectId/timeseries`      | member | Like the issue time series                    |

## Releases and environments

| Method | Path                                         | Who    | Notes                          |
| ------ | -------------------------------------------- | ------ | ------------------------------ |
| GET    | `/projects/:projectId/environments`          | member |                                |
| GET    | `/projects/:projectId/releases`              | member | With new-issue counts          |
| GET    | `/projects/:projectId/releases/:version`     | member |                                |
| GET    | `/projects/:projectId/releases/compare`      | member | `?a=1.0.0&b=1.1.0`             |

## Alert rules and incidents

| Method | Path                                          | Who    | Notes                               |
| ------ | --------------------------------------------- | ------ | ----------------------------------- |
| GET    | `/projects/:projectId/alert-rules`            | member |                                     |
| POST   | `/projects/:projectId/alert-rules`            | admin  | Conditions, match `any\|all`, severity, policy, cooldown |
| POST   | `/projects/:projectId/alert-rules/preview`    | member | "Test rule" against the last 24 h   |
| GET    | `/projects/:projectId/alert-rules/:ruleId`    | member |                                     |
| PATCH  | `/projects/:projectId/alert-rules/:ruleId`    | admin  |                                     |
| DELETE | `/projects/:projectId/alert-rules/:ruleId`    | admin  | The rule's incidents stay           |
| GET    | `/projects/:projectId/incidents`              | member | Paginated, `?status=`               |
| GET    | `/incidents/:incidentId`                      | member | With its timeline                   |
| POST   | `/incidents/:incidentId/acknowledge`          | member |                                     |
| POST   | `/incidents/:incidentId/resolve`              | member |                                     |
| POST   | `/incidents/:incidentId/link`                 | the link's token | `{ token }`. One-click link from a notification: shows the incident (`GET ?token=` also works) |
| POST   | `/incidents/:incidentId/link/acknowledge`     | the link's token | Acknowledges it            |

## On-call and escalation

| Method | Path                                             | Who    |
| ------ | ------------------------------------------------ | ------ |
| GET    | `/orgs/:orgId/schedules`                         | member |
| POST   | `/orgs/:orgId/schedules`                         | admin  |
| GET    | `/orgs/:orgId/oncall`                            | member |
| GET    | `/schedules/:scheduleId`                         | member |
| PATCH / DELETE | `/schedules/:scheduleId`                 | admin  |
| GET    | `/schedules/:scheduleId/oncall?at=`              | member |
| GET    | `/schedules/:scheduleId/shifts?from=&to=`        | member |
| POST   | `/schedules/:scheduleId/layers`                  | admin  |
| PATCH / DELETE | `/schedules/:scheduleId/layers/:layerId` | admin  |
| POST   | `/schedules/:scheduleId/overrides`               | member |
| DELETE | `/schedules/:scheduleId/overrides/:overrideId`   | member |
| GET    | `/orgs/:orgId/escalation-policies`               | member |
| POST   | `/orgs/:orgId/escalation-policies`               | admin  |
| GET    | `/escalation-policies/:policyId`                 | member |
| PATCH / DELETE | `/escalation-policies/:policyId`         | admin  |

## Notifications

| Method | Path                                                     | Who       |
| ------ | -------------------------------------------------------- | --------- |
| GET / POST | `/me/notification-channels`                          | signed in |
| PATCH / DELETE | `/me/notification-channels/:channelId`           | signed in |
| POST   | `/me/notification-channels/:channelId/test`              | signed in |
| POST   | `/me/notification-channels/:channelId/verify`            | signed in |
| POST   | `/me/notification-channels/:channelId/resend-code`       | signed in |
| GET    | `/me/notifications`                                      | signed in |
| GET    | `/orgs/:orgId/notification-channels`                     | member    |
| POST   | `/orgs/:orgId/notification-channels`                     | admin     |
| PATCH / DELETE | `/orgs/:orgId/notification-channels/:channelId`  | admin     |
| POST   | `/orgs/:orgId/notification-channels/:channelId/test`     | admin     |
| POST   | `/orgs/:orgId/notification-channels/:channelId/verify`   | admin     |
| POST   | `/orgs/:orgId/notification-channels/:channelId/resend-code` | admin  |
| GET    | `/orgs/:orgId/notifications`                             | member    |

A new email or SMS channel starts with `verified: false` and gets a 6-digit code (15 minutes,
5 tries). Nothing else is sent to it until `POST …/verify { code }` succeeds. Your own confirmed
account email, browser push, webhooks, Slack and Discord are verified right away. Members see
only the host of a team webhook; admins see the full URL.

Webhook requests carry an `X-Pulse-Signature` HMAC-SHA256 header, computed with the channel's
secret. That secret is shown once, when the channel is created.

## Health

`GET /health` returns `200 { status: "ok", db, redis, uptime }`, or `503` when Postgres or Redis
is down.
