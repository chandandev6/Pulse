# Security audit: Pulse
_2026-10-25 · Scope: `/home/chandan/Desktop/SDK_Pulse/Pulse` (working tree as on disk, including the uncommitted SSRF work in `apps/api/src/notifications/`) and `https://pulse-log.app` · Method: code review + passive live checks (about 30 GET/HEAD/OPTIONS requests, no logins, no payloads)_

## Summary
The core of Pulse is in good shape. Every dashboard route checks that the current user belongs to the org that owns the object, SQL always goes through Drizzle with parameters, passwords use argon2id, session and reset tokens are random and stored hashed, and the new SSRF guard holds up against the usual bypass tricks. The serious problems are at the edges. **The live site still answers on plain `http://` with no redirect and no HSTS**, so passwords and session cookies can travel unencrypted. **The API also trusts any `X-Forwarded-For` header** (`TRUST_PROXY=true` means "trust every hop"), so an attacker can choose their own IP address. That gets around every rate limit, login included, and puts fake IPs in the audit log. After those two, the main gaps are missing browser security headers and a few ways a free signup can make the server send email or SMS to strangers or fill the database.

No leaked secrets were found in tracked files, and the live site exposes no `.env`, `.git` or backup files.

| Severity | Count |
|---|---|
| 🔴 Critical | 0 |
| 🟠 High | 2 |
| 🟡 Medium | 5 |
| 🔵 Low | 6 |
| ⚪ Info | 4 |

## How the app works (security view)
- pnpm monorepo. `apps/api` is Fastify 5 + Drizzle (Postgres on Neon) + BullMQ/Redis, `apps/web` is a React SPA, and `packages/sdk-js` is the error SDK.
- Production path: Cloudflare (Tunnel) → nginx `web` container (`deploy/nginx.conf`) → `api:3000`. nginx serves the SPA, sends `/backend/*` to the API with the prefix removed, and passes `/api/*` (SDK ingest + source-map upload) and `/health` straight through.
- Auth: an HttpOnly cookie `pulse_session`, SameSite=Lax, 30 days. The DB stores only its SHA-256. Secure is set only when `WEB_PUBLIC_URL` is `https://` (`auth/session.ts:17`).
- Tenancy: users → memberships (owner/admin/member) → orgs → projects → issues/events/incidents. The guards in `orgs/access.ts` join through `memberships` for the current user, and outsiders get a 404.
- Public endpoints: signup, login, forgot/reset/verify, invitation preview, one-click incident links (HMAC token), `POST /api/:projectId/events` (public DSN key, CORS `*`), `PUT /api/:projectId/sourcemaps` (Bearer upload token).
- Outbound requests: org webhooks (any URL, SSRF-guarded), Slack/Discord (host allowlist), Web Push (SSRF-guarded agent), SMTP email, Twilio SMS.
- Rate limiting: `@fastify/rate-limit` in Redis, opt-in per route, keyed on `request.ip`.

## Findings

### [H1] Site and API work over plain HTTP: no HTTPS redirect, no HSTS
- **Severity:** High · **Where:** `http://pulse-log.app` (Cloudflare edge config), `deploy/nginx.conf`
- **What's wrong:** `http://pulse-log.app/` returns `200 OK` with no redirect, and the API works over HTTP too: `GET http://pulse-log.app/backend/auth/me` returns the API's JSON `401`. No response sends `Strict-Transport-Security`.
- **How an attacker uses it:** someone on the same café, office or college Wi-Fi as a user sees or changes traffic when the user types `pulse-log.app` or follows an `http://` link. A login form posted over HTTP sends the email and password in clear text. If the session cookie lacks `Secure` (see below), it goes over HTTP too and the attacker can take over the session.
- **Evidence:**
  ```
  $ curl -sI http://pulse-log.app/        → HTTP/1.1 200 OK   (no Location header)
  $ curl -s  http://pulse-log.app/backend/auth/me → 401 {"error":{"code":"UNAUTHENTICATED",...}}
  web_check: strict-transport-security: null
  ```
- **Needs confirmation (cookie):** the `.env.prod` in your local checkout has `PUBLIC_URL=http://localhost:8080`. If the VM's `.env.prod` says the same, `WEB_PUBLIC_URL` is `http://…`, so `sessionCookieOptions.secure` is **false** and the session cookie is sent over HTTP. Notification and reset links would also point at `localhost`. Check the VM's file.
- **Fix:**
  1. In Cloudflare, go to SSL/TLS → Edge Certificates and turn on **Always Use HTTPS** and **HSTS** (start with `max-age=15552000`, add `includeSubDomains` once you're sure).
  2. Make sure the VM's `.env.prod` has `PUBLIC_URL=https://pulse-log.app`, then recreate the containers.
  3. Belt and braces: set the header in nginx too (see M1).

### [H2] Client IP can be spoofed, so every rate limit can be bypassed (login brute force)
- **Severity:** High · **Where:** `apps/api/src/app.ts:44`, `docker-compose.prod.yml` (`TRUST_PROXY: "true"`), `apps/api/src/auth/routes.ts:42-62`
- **What's wrong:** `Fastify({ trustProxy: true })` trusts **every** entry in `X-Forwarded-For` and uses the left-most one as `request.ip`. nginx only *appends* to the header (`$proxy_add_x_forwarded_for`), and Cloudflare keeps whatever the client sent. So the client picks the left-most value.
- **How an attacker uses it:** they send `X-Forwarded-For: <random IP>` on every login attempt. The login limit (5 tries per 15 minutes per IP + email) becomes a fresh bucket on every request, which allows unlimited password guessing against any account. The same trick removes the limits on signup (bot accounts), forgot-password (flooding an inbox), invitations (spam), token endpoints and source-map uploads. The audit log (`audit/log.ts:52`) then records whatever IP the attacker chose.
- **Evidence:**
  ```ts
  // app.ts:44
  const app = Fastify({ logger: loggerOptions, trustProxy: config.TRUST_PROXY });
  // auth/routes.ts:47
  return `login:${request.ip}:${email}`;
  ```
  (Not tested against production. Confirm locally with `curl -H 'X-Forwarded-For: 1.2.3.4' …` repeated 6 times: you never get a 429.)
- **Fix:**
  - Trust only your own proxy hops instead of `true`. For example, accept a number: `trustProxy: 1` (only nginx), or the Docker subnet. Better still, have nginx put the real client IP in a header the client can't forge. Behind Cloudflare that header is `CF-Connecting-IP`:
    ```nginx
    # nginx: replace the client-supplied header with Cloudflare's verified one
    proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
    ```
    Then use `trustProxy: 1`. (Only safe if the origin can't be reached without going through Cloudflare. See L3.)
  - Also add a per-account limit on login that doesn't depend on IP, for example 20 failures per email per hour, so a botnet can't brute-force one account either.

### [M1] HTML app sends no browser security headers (CSP, frame, nosniff, Referrer-Policy)
- **Severity:** Medium · **Where:** `deploy/nginx.conf`, live `https://pulse-log.app/`
- **What's wrong:** none of `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy` or `Permissions-Policy` are set.
- **How an attacker uses it:** the dashboard shows data that strangers control. Anyone with a project's public DSN can send events with any titles, messages and tags. React escapes all of it today, but with no CSP, one future slip (a markdown renderer, a `dangerouslySetInnerHTML`) becomes full account takeover. With no frame protection, another site can load the dashboard in an invisible frame and trick a logged-in user into clicking "Rotate key", "Delete project" or "Acknowledge" (clickjacking). With no Referrer-Policy, the one-click acknowledge token in `?token=` (see L2) can leak to any outside site the page links to.
- **Fix:** add the headers in nginx. Test the CSP in report-only mode first:
  ```nginx
  add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
  ```
  nginx drops a server's `add_header` lines in any `location` that has its own `add_header` (`/assets/`, `/sw.js`, `=/`). Put the lines in a snippet and `include` it in each of those locations. The `ld+json` block in `index.html` isn't executed as script, so `script-src 'self'` doesn't break it.

### [M2] Any signup can make Pulse send email/SMS to arbitrary addresses (spam, SMS toll fraud)
- **Severity:** Medium (High if Twilio is configured in production) · **Where:** `apps/api/src/notifications/routes.ts:196-262`, `config.ts:130` (`REQUIRE_EMAIL_VERIFICATION` defaults to `false`)
- **What's wrong:** a user can add *any* email address or phone number as "their" contact method, with no proof they own it, and press **Test**, which sends a real message. The test limit is keyed by `channelId` (5 per 10 minutes), so deleting and re-creating the channel gives a fresh limit. Org admins can do the same with org email channels, and with invitations (`orgs/invitations.ts`, 20 per hour per spoofable IP, see H2). Email verification is enforced only when `REQUIRE_EMAIL_VERIFICATION=true`, which isn't set in `.env.prod`.
- **How an attacker uses it:** a script signs up, adds a victim's phone number, and loops create → test → delete. Each SMS costs you Twilio money, and premium-rate numbers make this "SMS pumping" fraud. With email, your Gmail SMTP account sends spam that the attacker writes (org names and user names appear in invitation subjects), which can get the account blocked or blacklisted.
- **Fix:**
  - Set `REQUIRE_EMAIL_VERIFICATION=true` in production now that email works.
  - Verify each new email/SMS channel before it can be used: send a code or link and keep the channel disabled until it's confirmed.
  - Key the test rate limit on the **user/org** instead of the channel id, and add a daily cap on outbound SMS/email per user and per org.

### [M3] A free account can fill the database (source maps and ingest quotas have no ceiling)
- **Severity:** Medium · **Where:** `apps/api/src/sourcemaps/routes.ts:185-220`, `apps/api/src/projects/schemas.ts:21-23`
- **What's wrong:** an org admin, which every new signup is for their own org, can (a) create upload tokens and store unlimited source maps. There is no per-project storage cap, and release/name are free text, so each upload is a new row. 1 MB through nginx (20 MB direct) × 300 per hour per IP, and the IP is spoofable. They can also (b) set `monthlyQuota: null` (unlimited) and `rateLimitPerMinute: 100000` on their own project and pump events in.
- **How an attacker uses it:** sign up, create a project, then upload random-content maps or send events in a loop. Neon's storage limit fills up and the whole hosted service stops for every user.
- **Fix:** let only the platform operator change limits (or cap them per plan): ignore `monthlyQuota`/`rateLimitPerMinute` from org admins on the hosted instance, or clamp them to a hosted maximum. Add a per-project source-map cap (for example 200 MB total, or N releases with the oldest pruned), and drop maps for releases that no longer have events in retention.

### [M4] Dependency with a known High advisory on a public input path (zod)
- **Severity:** Medium · **Where:** `apps/api/package.json` (`pnpm audit --prod`)
- **What's wrong:** `pnpm audit --prod` reports 1 high, 5 moderate and 5 low:
  - **zod < 4.6.6 (High)**: "can exhaust memory while validating oversized constrained collections". Zod validates every request body, including the public ingest endpoint (`EventSchema`, which has `z.record` for headers/context/tags). The 200 KB body limit softens it, but the input is public.
  - **ip-address ≤ 10.7.3 (Moderate)** via `@fastify/rate-limit`: quadratic-time parsing of a long IPv6 zone id. Combined with H2, the attacker controls the "IP" string that reaches it.
  - **fast-uri (Moderate/Low)** via fastify's ajv compiler: low reachability, since you validate with zod.
  - **fastify 5.12.2–5.12.5 (Low)**: header validation bypass.
- **Fix:** `pnpm --filter @pulse/api up zod@^4.6.6 fastify@^5.12.6 @fastify/rate-limit@latest`, then refresh the lockfile so `ip-address ≥ 10.7.4` and `fast-uri ≥ 3.1.9 / 4.2.3` come in. Re-run `pnpm audit --prod`.

### [M5] Admins can add any registered user to their org without consent (and learn which emails have accounts)
- **Severity:** Medium · **Where:** `apps/api/src/orgs/routes.ts:135-166`
- **What's wrong:** `POST /orgs/:orgId/members` adds an existing account straight away by email. The answer differs too: `404 USER_NOT_FOUND` "No Pulse account uses this email" versus `201`. Every signup is admin of its own org, so anyone can use it. Now that email invitations exist (`orgs/invitations.ts`), this older path isn't needed.
- **How an attacker uses it:** (1) work out which emails have Pulse accounts by trying addresses against their own org. Login and forgot-password were carefully built *not* to reveal this. (2) Add a victim to an org, put them in a schedule or escalation policy, and trigger incidents. The victim then gets alert emails/SMS/push they never agreed to.
- **Fix:** remove direct add, or limit it to users who already share an org with the admin. Use invitations (which need the invitee to click) for everyone else, and always reply with the same message.

### [L1] Signup reveals whether an email is registered
- **Severity:** Low · **Where:** `apps/api/src/auth/routes.ts:96-99`
- **What's wrong / impact:** `409 EMAIL_TAKEN` tells anyone which emails have accounts. Login and forgot-password deliberately hide this. Combined with H2, it can be done at scale.
- **Fix:** answer signup the same way either way ("Check your inbox"), and email the existing account owner instead. Or accept this as a UX trade-off, but fix H2 so it can't be done in bulk.

### [L2] One-click acknowledge token travels in the URL query and works for 7 days
- **Severity:** Low · **Where:** `apps/api/src/notifications/links.ts:16,47-48`, `apps/web/src/pages/IncidentLinkPage.tsx:29`
- **What's wrong:** `ackUrl` puts the HMAC token in `?token=`. That ends up in Cloudflare/nginx logs and browser history, and without a Referrer-Policy it can leak in `Referer` headers. Anyone holding a personal link can acknowledge as that user without logging in, for 7 days. The reset/verify/invite links already put the token after `#` for exactly this reason.
- **Fix:** move it to the fragment (`/incidents/:id/acknowledge#token=…`) the way the auth links do, and shorten the TTL (24 hours is plenty for an incident). M1's Referrer-Policy also helps.

### [L3] Origin web port published on all interfaces (Cloudflare bypass): needs confirmation
- **Severity:** Low (Medium if reachable) · **Where:** `docker-compose.prod.yml` (`web.ports: "${WEB_PORT:-8080}:80"`)
- **What's wrong:** Docker publishes 8080 on `0.0.0.0` and skips the host firewall (ufw). With Cloudflare Tunnel you don't need any public port. If the Azure NSG allows 8080, people can reach the origin directly over plain HTTP, skipping Cloudflare's TLS and WAF. Any fix for H2 that relies on Cloudflare headers can then be faked.
- **Fix:** bind to loopback, `"127.0.0.1:${WEB_PORT:-8080}:80"` (cloudflared on the host connects to localhost), and confirm the NSG has no inbound rule for 8080.

### [L4] Sessions: long fixed lifetime, other devices stay logged in after login
- **Severity:** Low · **Where:** `apps/api/src/auth/session.ts:10,29-36`
- **What's wrong:** sessions last 30 days with no idle timeout. There is no "log out everywhere" button and no list of active sessions. Password reset *does* revoke all sessions (good). A stolen cookie stays valid for up to a month.
- **Fix:** add an idle timeout (for example slide expiry by 7 days on use, hard cap 30), and a "sign out other sessions" action on the account page.

### [L5] Org webhook URL shown to every member; channel/webhook secrets stored in plaintext
- **Severity:** Low · **Where:** `apps/api/src/notifications/routes.ts:69-78`
- **What's wrong:** `toPublic` hides Slack/Discord URLs but returns the full generic webhook URL to every org member. Many receivers (Zapier, n8n, custom) put a secret in the URL. Webhook signing secrets sit in plaintext in `notification_channels.config`, which HMAC signing needs, but it means a DB leak exposes them.
- **Fix:** show only the host (as for Slack) to non-admins. If you want, encrypt channel configs at rest with a key derived from `APP_SECRET`.

### [L6] GitHub Actions pinned by tag, not commit SHA
- **Severity:** Low · **Where:** `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- **What's wrong:** `actions/checkout@v4`, `pnpm/action-setup@v4`, `docker/*@v3/v6` are mutable tags. The deploy job holds an SSH key to the production VM. That job runs no third-party actions, which is good, but CI does, and it runs on every push.
- **Fix:** pin third-party actions to full commit SHAs (Dependabot can keep them updated). The deploy workflow already does the important things right: `workflow_run` only on a successful push, `known_hosts` provided, no `StrictHostKeyChecking=no`.

### [I1] `/health` is public and shows dependency status
- **Where:** `apps/api/src/app.ts:78-92`, live `https://pulse-log.app/health` → `{"status":"ok","db":"ok","redis":"ok","uptime":…}`
- Harmless, but it tells an attacker when the DB or Redis is struggling. You could return only `{status}` publicly and keep the details for the internal Docker healthcheck.

### [I2] SSRF guard (uncommitted work) reviewed: solid, minor notes
- **Where:** `apps/api/src/notifications/ssrf.ts`, `webhook.ts`, `push.ts`, `chat.ts`
- What's done well: the IP check runs inside the `lookup` hook, which removes the DNS-rebinding window. *Every* resolved address must be public. Raw-IP hosts are checked separately. IPv4-mapped IPv6 is handled (also in the normalized hex form `::ffff:7f00:1`, which Node's BlockList maps correctly). The cloud metadata range is blocked. Redirects are never followed. 10-second timeouts are in place. Slack/Discord use a host allowlist with `redirect: "error"`. Web Push uses the guarded agent. Checks are repeated at send time, so rows saved before the guard are covered too. I tested the filter with edge cases (`::ffff:169.254.169.254`, `127.1`, `2130706433`, `[::ffff:10.0.0.1]`): all were blocked.
- Minor: deprecated IPv4-compatible (`::a.b.c.d`) and 6to4 (`2002::/16`) addresses count as public. Linux doesn't normally route these to local hosts, but adding `::/96` and `2002::/16` to the blocklist costs nothing. `localhost.` (trailing dot) passes the save-time `looksPrivate` check but is blocked at send. Delivery error text such as `ECONNREFUSED` shows up in the log for public targets, a small port-scan oracle. Consider reducing errors to a generic "connection failed".

### [I3] nginx 1 MB body limit vs 20 MB source-map limit
- `deploy/nginx.conf` sets `client_max_body_size 1m` for every location, so in production source-map uploads over 1 MB fail with nginx's 413 even though the API allows 20 MB. That's a functional bug, but a useful cap until M3 is fixed. If you raise it, do it only in a `location ~ ^/api/[^/]+/sourcemaps$` block.

### [I4] No `/.well-known/security.txt`
- Nice to have, so researchers know how to report issues to you. The live probe got the SPA fallback page.

## What's already good
- **Access control is consistent and correct.** Every `:orgId`/`:projectId`/`:issueId`/`:eventId`/`:scheduleId`/`:incidentId`/`:policyId` route uses a guard that joins through `memberships` for the current user (`orgs/access.ts`). Sub-objects (keys, alert rules, layers, overrides, invitations, upload tokens, channels) are also filtered by their parent. Bulk issue updates filter `ids` to the project. Assignees, schedule participants and escalation targets are checked as org members. Owner/last-owner rules use row locks.
- **Auth:** argon2id with OWASP parameters, dummy-hash timing equalization, uniform login/forgot errors, 256-bit reset/verify/invite tokens stored as SHA-256, single-use via `DELETE … RETURNING`, 1-hour reset TTL, reset revokes all sessions, tokens in URL fragments.
- **Sessions:** HttpOnly, SameSite=Lax, random 256-bit token, only the hash in the DB, expiry enforced server-side.
- **Injection:** all SQL is parameterized Drizzle. The single `sql.raw` uses a server constant. LIKE input is escaped. `websearch_to_tsquery` handles free text. No `exec`/`eval`/fs paths built from user input.
- **XSS:** no `dangerouslySetInnerHTML`/`innerHTML` anywhere in the web app. Email HTML escapes every user value. Slack escapes `<>&` and Discord disables mentions.
- **CORS:** `*` only on the cookie-less ingest plugin. Dashboard routes don't reflect origins (confirmed live).
- **Secrets:** `.env*` are git-ignored and docker-ignored, and only `.example` files are tracked. The secret scanner found only test fixtures. The app refuses to start in production with the dev `APP_SECRET`. The SDK and the server-side scrubber strip cookies, authorization headers, passwords and card numbers.
- **Errors:** 5xx responses are generic and stack traces are only logged.
- **Infra:** the API image runs as a non-root `node` user with production deps only. Postgres/Redis have no published ports. Mailpit binds to `127.0.0.1`. TLS 1.0/1.1 are rejected, the certificate is valid for 89 days (Let's Encrypt, auto-renewed), and no sensitive files are exposed (every probe returned the SPA fallback).

## Checked, nothing found
SQL/NoSQL/command/path/template injection · XSS in the dashboard and emails · CSRF (SameSite=Lax + JSON bodies, no state change on GET; the one-click link GET is read-only) · mass assignment (every update goes through a closed zod schema) · JWT/OAuth (not used) · crypto/randomness (`crypto.randomBytes` everywhere, `timingSafeEqual` for HMACs) · password-reset flow · invitation acceptance (single-use, expiring) · cross-tenant IDOR on every route file · secrets in the repo · exposed files on the live site · CORS on dashboard routes · TLS configuration · Dockerfile user and secrets · CI `pull_request_target` (not used).

## Suggested next steps
1. **Today:** turn on Cloudflare *Always Use HTTPS* + HSTS, and confirm `PUBLIC_URL=https://pulse-log.app` on the VM (H1).
2. **Fix the IP trust** (H2): `trustProxy: 1` + `CF-Connecting-IP` from nginx, bind the web port to `127.0.0.1` (L3), and add a per-email login limit.
3. **Add the nginx security headers** (M1) and move the ack token into the URL fragment (L2).
4. **Turn on `REQUIRE_EMAIL_VERIFICATION`**, verify new channels before use, and rate-limit tests per user (M2). Remove direct member-add (M5).
5. **Cap per-project storage and limits** on the hosted instance (M3).
6. **Update zod / fastify / @fastify/rate-limit** (M4).
7. For deeper testing, run an OWASP ZAP baseline scan (`zap-baseline.py -t https://staging…`) against a staging copy, and scan git history with `gitleaks detect` (this audit only scanned files currently tracked).

_Note: the working tree changed while the audit ran (new untracked files such as `apps/web/src/pages/AccountPages.tsx` and `apps/api/test/accounts.test.ts` appeared). The account pages were not reviewed._
