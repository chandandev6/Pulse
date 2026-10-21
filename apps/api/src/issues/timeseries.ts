import { and, count, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db/client.js";
import { events } from "../db/schema.js";
import { AppError } from "../errors.js";
import { PERIODS, type TimeseriesQuerySchema } from "./schemas.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STEP_MS = { hour: HOUR, day: DAY } as const;

// Enough for 14 days by the hour; 30 days by the hour would be 720 points, too many for a chart
const MAX_BUCKETS = 400;

type TimeseriesQuery = z.infer<typeof TimeseriesQuerySchema>;

// Event counts per hour or per day, for frequency charts.
// Buckets are in UTC and counted from 1970, so they're the same in SQL and JS:
// bucket number = floor(seconds since 1970 / seconds per bucket).
// Empty hours/days come back as 0, so a chart has no gaps.
export async function eventTimeseries(
  scope: SQL,
  query: TimeseriesQuery,
  now = new Date(),
): Promise<{ interval: string; buckets: { start: string; count: number }[] }> {
  const days = PERIODS[query.period];
  const interval = query.interval ?? (days <= 7 ? "hour" : "day");
  const step = STEP_MS[interval];

  const first = Math.floor((now.getTime() - days * DAY) / step);
  const last = Math.floor(now.getTime() / step); // the current, still-filling bucket
  if (last - first + 1 > MAX_BUCKETS) {
    throw new AppError(
      400,
      "TOO_MANY_BUCKETS",
      `A ${query.period} chart by the ${interval} has too many points; use interval=day`,
    );
  }

  // sql.raw is safe here: step comes from our own constant, never from the request
  const bucket = sql<number>`floor(extract(epoch from ${events.timestamp}) / ${sql.raw(String(step / 1000))})`;

  const rows = await db
    .select({ bucket: bucket.mapWith(Number), count: count() })
    .from(events)
    .where(
      and(
        scope,
        query.environment ? eq(events.environment, query.environment) : undefined,
        gte(events.timestamp, new Date(first * step)),
        lt(events.timestamp, new Date((last + 1) * step)),
      ),
    )
    .groupBy(bucket);

  const counts = new Map(rows.map((row) => [row.bucket, row.count]));
  const buckets = [];
  for (let n = first; n <= last; n++) {
    buckets.push({ start: new Date(n * step).toISOString(), count: counts.get(n) ?? 0 });
  }
  return { interval, buckets };
}
