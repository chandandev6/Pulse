import { Link } from "react-router";
import type { OnCallNow, Shift } from "../api/schedules";
import { fullDate } from "../format";
import { Loading } from "./States";

// The same person always gets the same colour (8 to choose from)
export function colourOf(userId: string | undefined) {
  if (!userId) return "who-none";
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `who-${hash % 8}`;
}

const time = (date: Date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (date: Date) =>
  date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

// "Who's on call now": one line per schedule
export function OnCallWidget({
  oncall,
  isLoading,
  linkTo,
}: {
  oncall: OnCallNow[] | undefined;
  isLoading: boolean;
  linkTo: (scheduleId: string) => string;
}) {
  if (isLoading) return <Loading />;
  if (!oncall?.length) return <p className="muted">No on-call schedules yet.</p>;

  return (
    <ul className="oncall-list">
      {oncall.map(({ schedule, onCall, until }) => (
        <li key={schedule.id} className="oncall-item">
          <span className={`who-dot ${colourOf(onCall?.user.id)}`} aria-hidden="true" />
          <div>
            <Link to={linkTo(schedule.id)} className="issue-title">
              {schedule.name}
            </Link>
            <div>
              {onCall ? (
                <>
                  <strong>{onCall.user.name}</strong>
                  {onCall.source === "override" && <span className="muted"> (covering)</span>}
                </>
              ) : (
                <strong className="form-error">Nobody is on call</strong>
              )}
            </div>
            {until && (
              <div className="muted" title={fullDate(until)}>
                until {day(new Date(until))}, {time(new Date(until))}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// The next N days as rows; each row is a 24-hour bar split into who is on call.
// Shown in the viewer's own timezone.
export function ShiftTimeline({
  shifts,
  from,
  days,
}: {
  shifts: Shift[];
  from: Date;
  days: number;
}) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);

  const rows = Array.from({ length: days }, (_, i) => {
    const dayStart = new Date(start);
    dayStart.setDate(start.getDate() + i); // setDate, not +24h: a DST day isn't 24 hours
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);
    const length = dayEnd.getTime() - dayStart.getTime();

    const pieces = shifts
      .map((shift) => {
        const a = Math.max(new Date(shift.start).getTime(), dayStart.getTime());
        const b = Math.min(new Date(shift.end).getTime(), dayEnd.getTime());
        return { shift, a, b };
      })
      .filter(({ a, b }) => b > a);
    return { dayStart, length, pieces };
  });

  const people = new Map(
    shifts.flatMap((s) => (s.onCall ? [[s.onCall.user.id, s.onCall.user.name] as const] : [])),
  );
  const now = Date.now();

  return (
    <div className="timeline">
      <div className="timeline-legend">
        {[...people].map(([id, name]) => (
          <span key={id}>
            <span className={`who-dot ${colourOf(id)}`} aria-hidden="true" /> {name}
          </span>
        ))}
        <span className="muted">
          Times in your timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone})
        </span>
      </div>
      {rows.map(({ dayStart, length, pieces }) => (
        <div key={dayStart.toISOString()} className="timeline-row">
          <span className="timeline-day">{day(dayStart)}</span>
          <div className="timeline-bar">
            {pieces.map(({ shift, a, b }) => (
              <span
                key={`${shift.start}-${a}`}
                className={`timeline-piece ${colourOf(shift.onCall?.user.id)}`}
                style={{
                  left: `${((a - dayStart.getTime()) / length) * 100}%`,
                  width: `${((b - a) / length) * 100}%`,
                }}
                title={`${shift.onCall?.user.name ?? "Nobody"}: ${time(new Date(a))}–${time(new Date(b))}${shift.onCall?.source === "override" ? " (override)" : ""}`}
              />
            ))}
            {now >= dayStart.getTime() && now < dayStart.getTime() + length && (
              <span
                className="timeline-now"
                style={{ left: `${((now - dayStart.getTime()) / length) * 100}%` }}
                title="Now"
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// The same shifts as a list, for reading (and screen readers)
export function ShiftList({ shifts, limit = 10 }: { shifts: Shift[]; limit?: number }) {
  return (
    <table className="issue-table">
      <thead>
        <tr>
          <th>On call</th>
          <th>From</th>
          <th>Until</th>
        </tr>
      </thead>
      <tbody>
        {shifts.slice(0, limit).map((shift) => (
          <tr key={shift.start}>
            <td>
              <span className={`who-dot ${colourOf(shift.onCall?.user.id)}`} aria-hidden="true" />{" "}
              {shift.onCall?.user.name ?? <span className="form-error">Nobody</span>}
              {shift.onCall && (
                <span className="muted">
                  {" "}
                  · {shift.onCall.source === "override" ? "override" : shift.onCall.layer?.name}
                </span>
              )}
            </td>
            <td>
              {day(new Date(shift.start))}, {time(new Date(shift.start))}
            </td>
            <td>
              {day(new Date(shift.end))}, {time(new Date(shift.end))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
