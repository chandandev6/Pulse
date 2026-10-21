import { type KeyboardEvent, useState } from "react";
import { useTimeseries } from "../api/queries";
import type { Timeseries, TimeseriesPeriod } from "../api/types";
import { useEnvironment } from "../environment";
import { count } from "../format";
import { ErrorState, Loading } from "./States";

const hourFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const fullFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const PERIOD_LABELS: Record<TimeseriesPeriod, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "14d": "14 days",
  "30d": "30 days",
  "90d": "90 days",
};

// The top of the y-axis: a round number ≥ max whose half is round too (0 / 5 / 10, 0 / 20 / 40)
export function niceMax(max: number): number {
  if (max <= 0) return 0;
  const half = max / 2;
  const power = Math.max(1, 10 ** Math.floor(Math.log10(half))); // counts are whole numbers
  const step = [1, 2, 5, 10].map((n) => n * power).find((n) => n >= half) ?? 10 * power;
  return step * 2;
}

function bucketLabel(start: string, interval: Timeseries["interval"]) {
  const date = new Date(start);
  return interval === "hour" ? hourFormat.format(date) : dayFormat.format(date);
}

// "Oct 22, 14:00" for an hour, "Oct 22" for a day
function bucketTitle(start: string, interval: Timeseries["interval"]) {
  const date = new Date(start);
  return interval === "hour" ? fullFormat.format(date) : dayFormat.format(date);
}

// A column per hour/day. Hover or focus (then ← →) shows the exact count;
// a hidden table gives screen readers every value.
export function FrequencyChart({ series, label }: { series: Timeseries; label: string }) {
  const { buckets, interval } = series;
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(0, ...buckets.map((b) => b.count)));
  const shown = active === null ? null : buckets[active];

  const onKeyDown = (e: KeyboardEvent) => {
    const last = buckets.length - 1;
    const moves: Record<string, number> = {
      ArrowLeft: Math.max(0, (active ?? last + 1) - 1),
      ArrowRight: Math.min(last, (active ?? -1) + 1),
      Home: 0,
      End: last,
    };
    if (e.key in moves) {
      e.preventDefault();
      setActive(moves[e.key] ?? null);
    }
  };

  // The tooltip sits beside the hovered column (right of it on the left half,
  // left of it on the right half), so it never covers that bar or the panel header
  const n = buckets.length;
  const onRight = active !== null && active < n / 2;
  const tooltipLeft = active === null ? 0 : ((onRight ? active + 1 : active) / n) * 100;

  return (
    <figure className="chart">
      <div className="chart-body">
        <div className="chart-y" aria-hidden="true">
          {top > 0 && (
            <>
              <span>{count(top)}</span>
              <span>{count(top / 2)}</span>
              <span>0</span>
            </>
          )}
        </div>

        {/* A slider: ← → move between hours/days, and screen readers hear each value */}
        <div
          className="chart-plot"
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={buckets.length - 1}
          aria-valuenow={active ?? buckets.length - 1}
          aria-valuetext={
            shown
              ? `${shown.count} ${shown.count === 1 ? "event" : "events"}, ${bucketTitle(shown.start, interval)}`
              : "Use the arrow keys to read each bar"
          }
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <div className="chart-grid" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          {top === 0 && <p className="chart-empty muted">No events in this period</p>}
          <div className="chart-columns" aria-hidden="true">
            {buckets.map((bucket, i) => (
              <div
                key={bucket.start}
                className={i === active ? "chart-col active" : "chart-col"}
                onPointerEnter={() => setActive(i)}
              >
                {bucket.count > 0 && (
                  <div
                    className="chart-bar"
                    data-testid="chart-bar"
                    style={{ height: `${(bucket.count / top) * 100}%` }}
                  />
                )}
              </div>
            ))}
          </div>

          {shown && (
            <div
              className={onRight ? "chart-tooltip" : "chart-tooltip chart-tooltip-left"}
              style={{ left: `${tooltipLeft}%` }}
              role="status"
            >
              <strong>
                {count(shown.count)} {shown.count === 1 ? "event" : "events"}
              </strong>
              <span>{bucketTitle(shown.start, interval)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="chart-x" aria-hidden="true">
        <span>{buckets[0] && bucketLabel(buckets[0].start, interval)}</span>
        <span>
          {buckets[Math.floor(buckets.length / 2)] &&
            bucketLabel(buckets[Math.floor(buckets.length / 2)]?.start ?? "", interval)}
        </span>
        <span>Now</span>
      </div>

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{interval === "hour" ? "Hour" : "Day"}</th>
            <th scope="col">Events</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.start}>
              <td>{bucketTitle(bucket.start, interval)}</td>
              <td>{bucket.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// A panel with a title, a period switch and the chart.
// `path` is "/projects/<id>" or "/issues/<id>".
export function FrequencyPanel({
  path,
  title,
  periods,
}: {
  path: string;
  title: string;
  periods: TimeseriesPeriod[];
}) {
  const [period, setPeriod] = useState(periods[0] ?? "24h");
  const { environment } = useEnvironment();
  const series = useTimeseries(path, period, environment);
  const total = series.data?.buckets.reduce((sum, b) => sum + b.count, 0);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          {total !== undefined && (
            <p className="chart-total">
              <strong>{count(total)}</strong> {total === 1 ? "event" : "events"} in the last{" "}
              {PERIOD_LABELS[period]}
            </p>
          )}
        </div>
        <fieldset className="segmented">
          <legend className="sr-only">Time range</legend>
          {periods.map((value) => (
            <button
              key={value}
              type="button"
              className={value === period ? "segment active" : "segment"}
              aria-pressed={value === period}
              onClick={() => setPeriod(value)}
            >
              {PERIOD_LABELS[value]}
            </button>
          ))}
        </fieldset>
      </div>

      {series.isLoading && <Loading />}
      {series.error && <ErrorState error={series.error} retry={() => series.refetch()} />}
      {series.data && (
        <FrequencyChart
          series={series.data}
          label={`${title}, last ${PERIOD_LABELS[period]}, per ${series.data.interval}`}
        />
      )}
    </section>
  );
}
