# Self-hosting Pulse

Pulse runs as six containers from one compose file:

| Container  | What it does                                                                |
| ---------- | --------------------------------------------------------------------------- |
| `web`      | nginx, the only public port. Serves the dashboard and forwards API calls     |
| `api`      | The HTTP API (Fastify). Receives events and puts them in a queue             |
| `worker`   | Saves events, groups them into issues, fires alerts, sends notifications     |
| `migrate`  | Runs at every start, applies new database migrations, then exits             |
| `postgres` | The database (skip it if you use a hosted Postgres)                          |
| `redis`    | Queues, rate limits, alert windows (skip it if you use a hosted Redis)       |
| `mailpit`  | Catches outgoing email until you set up real SMTP (inbox on `localhost:8025`) |

```
SDKs ──POST /api/…──┐
                    ▼
Browser ──────────► web (nginx :8080) ──► api ──► Redis queue ──► worker ──► Postgres
                                           └──────────── Postgres ◄──────────┘
```

## 1. Requirements

- Docker with Compose v2 (`docker compose version`)
- 2 GB RAM, 1 CPU is enough to start

## 2. Start

```bash
git clone https://github.com/chandandev6/Pulse.git && cd Pulse
cp .env.prod.example .env.prod
```

Edit `.env.prod`: set `APP_SECRET` (run `openssl rand -base64 48`) and `POSTGRES_PASSWORD`.
Then start everything with one command:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Open http://localhost:8080, sign up, and create a project. **Settings** shows the DSN for the SDK.
To check it works: `curl http://localhost:8080/health` should print `"status":"ok"`.

## 3. Configuration

Everything goes in `.env.prod`. The compose file passes it to the containers.

| Variable                  | Default                     | Meaning                                                    |
| ------------------------- | --------------------------- | ---------------------------------------------------------- |
| `APP_SECRET`              | —  (required)               | Signs links in notifications. Keep it secret               |
| `POSTGRES_PASSWORD`       | —  (required)               | Password of the bundled Postgres                           |
| `PUBLIC_URL`              | `http://localhost:8080`     | Where people and SDKs reach Pulse. Used in DSNs and links  |
| `WEB_PORT`                | `8080`                      | Port nginx listens on                                      |
| `DATABASE_URL`            | the bundled Postgres        | A hosted Postgres instead (see below)                      |
| `REDIS_URL`               | the bundled Redis           | A hosted Redis instead                                     |
| `SMTP_HOST`, `SMTP_PORT`  | `mailpit`, `1025`           | Your email provider's SMTP server                          |
| `SMTP_USER`, `SMTP_PASS`  | empty                       | SMTP login                                                 |
| `SMTP_SECURE`             | `false`                     | `true` for TLS from the start (usually port 465)           |
| `SMTP_FROM`               | `Pulse <alerts@pulse.local>`| Sender of notification emails                              |
| `TWILIO_*`, `VAPID_*`     | empty                       | Optional SMS and browser push (see `.env.example`)         |

After changing `.env.prod`, run the same `up -d` command again: only changed containers restart.

## 4. HTTPS and a domain

Put a TLS proxy in front of port 8080, for example [Caddy](https://caddyserver.com) on the host:

```
pulse.example.com {
  reverse_proxy localhost:8080
}
```

Then set `PUBLIC_URL=https://pulse.example.com`. With an `https` URL, session cookies are marked
`Secure`. Existing DSNs contain the old URL, so copy the new DSN into your apps.

## 5. Hosted databases (Neon, Upstash, …)

Only two settings change. Pulse doesn't care where the databases run.

1. Create a Postgres database (for example on [Neon](https://neon.tech)) and copy its connection
   string. Keep `?sslmode=require` at the end.
2. Create a Redis database (for example on [Upstash](https://upstash.com)). Use the `rediss://`
   (TLS) URL.
3. In `.env.prod`:
   ```bash
   DATABASE_URL=postgres://user:password@ep-xxx.eu-central-1.aws.neon.tech/pulse?sslmode=require
   REDIS_URL=rediss://default:password@xxx.upstash.io:6379
   ```
4. Run `up -d` again. The `migrate` container creates every table in the new database.
   (Pulse needs the `pg_trgm` extension, which Neon supports.)
5. Optional: delete the `postgres` and `redis` services from `docker-compose.prod.yml`, along
   with the `depends_on` entries that point at them.

Moving existing data: `pg_dump` from the old database, then `psql` into the new one before step 4.

## 6. Data, limits and privacy

Each project has these settings under **Settings → Data & limits**:

- **Events per minute** (default 1000). Over the limit, ingestion answers `429` with a
  `Retry-After` header, and the SDK pauses until then.
- **Monthly quota** (default none). Counted per calendar month in UTC.
- **Retention** (default 90 days). The worker deletes older events every night at 03:00 UTC,
  in batches. Issues keep their counts and history.
- **Scrubbing** (on by default). Passwords, tokens, cookies, `Authorization` headers and card
  numbers are replaced with `[Filtered]` *before* the event is queued, so they never reach Redis
  or Postgres. You can add extra field names and choose to drop IP addresses.

The **Audit log** (Settings → Audit log, admins only) records who changed members, project
settings, keys, alert rules, schedules, escalation policies and team notification channels.
It also records the IP address each change came from.

## 7. Operating it

```bash
# Logs (JSON, one line per request or job)
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api worker

# Upgrade: get new code, rebuild. Migrations run by themselves.
git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

# Backup the bundled database
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U pulse pulse | gzip > pulse-$(date +%F).sql.gz

# More workers when events pile up (each runs 10 jobs at a time)
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --scale worker=3

# Stop (data stays in the volumes). Adding -v would DELETE all data.
docker compose --env-file .env.prod -f docker-compose.prod.yml down
```

## 8. How much it handles

Measured with `pnpm load-test` (autocannon, 50 connections, 15 s). The test ran on one laptop
with the whole compose stack, every request going through nginx, and 20 distinct errors:

| What                         | Result                          |
| ---------------------------- | ------------------------------- |
| Ingestion (API accepts)      | ~1,900 events/s, p99 latency ~60 ms |
| One worker (saves + groups)  | ~380 events/s, steady          |

The API answers right away and the queue absorbs bursts, so short spikes are fine even when the
worker is slower. For more sustained throughput, scale the worker (see above). The load test
found one bottleneck. Every event updates its release and environment counters, and those rows
were locked for the whole save, so workers waited in line. Those updates now run last in the
transaction. That made a worker about 1.5× faster, and it no longer slows down as the queue grows.

To run it yourself, raise the project's events-per-minute first:

```bash
PULSE_DSN="http://<key>@localhost:8080/<project-id>" DURATION=20 pnpm load-test
```

## 9. Troubleshooting

| Symptom                                    | Fix                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `Set APP_SECRET in .env.prod`              | Fill in `APP_SECRET`, and pass `--env-file .env.prod`                |
| Login works but you're logged out at once  | `PUBLIC_URL` says `https` but you open Pulse over `http` (or the other way) |
| Events accepted (202) but never show up    | `docker compose … logs worker`: the worker must be running           |
| `429` from ingestion                        | The project hit its per-minute limit or monthly quota (Settings)     |
| No emails                                   | Check `SMTP_*`. Until then, emails land in Mailpit at `localhost:8025` |
