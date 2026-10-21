import { Link, useParams, useSearchParams } from "react-router";
import { useActivity, useEvent, useIssue, useUpdateIssue } from "../api/queries";
import type { Activity, Issue, IssueStatus, PulseEvent, Severity } from "../api/types";
import { RegressionBadge, SeverityBadge, StatusBadge } from "../components/Badges";
import { FrequencyPanel } from "../components/FrequencyChart";
import { KeyValue } from "../components/KeyValue";
import { StackTrace } from "../components/StackTrace";
import { ErrorState, Loading } from "../components/States";
import { count, fullDate, timeAgo } from "../format";

const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

function Actions({ issue }: { issue: Issue }) {
  const update = useUpdateIssue(issue);
  const setStatus = (status: IssueStatus) => update.mutate({ status });

  return (
    <div className="actions">
      {issue.status === "unresolved" ? (
        <>
          <button
            type="button"
            className="button button-primary"
            disabled={update.isPending}
            onClick={() => setStatus("resolved")}
          >
            Resolve
          </button>
          <button
            type="button"
            className="button"
            disabled={update.isPending}
            onClick={() => setStatus("ignored")}
          >
            Ignore
          </button>
        </>
      ) : (
        <button
          type="button"
          className="button"
          disabled={update.isPending}
          onClick={() => setStatus("unresolved")}
        >
          Reopen
        </button>
      )}
      <label className="inline-label">
        Severity
        <select
          value={issue.severity}
          disabled={update.isPending}
          onChange={(e) => update.mutate({ severity: e.target.value as Severity })}
        >
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severity}
            </option>
          ))}
        </select>
      </label>
      {update.error && (
        <span className="form-error" role="alert">
          {update.error.message}
        </span>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mini-stat">
      <div className="mini-stat-label">{label}</div>
      <div className="mini-stat-value">{children}</div>
    </div>
  );
}

function EventNavigator({
  event,
  previousEventId,
  nextEventId,
}: {
  event: PulseEvent;
  previousEventId: string | null;
  nextEventId: string | null;
}) {
  const [, setParams] = useSearchParams();
  const go = (id: string | null) => id && setParams({ event: id });

  return (
    <div className="event-nav">
      <span title={fullDate(event.timestamp)}>
        Event from <strong>{timeAgo(event.timestamp)}</strong>
      </span>
      <div className="event-nav-buttons">
        <button
          type="button"
          className="button button-small"
          disabled={!previousEventId}
          onClick={() => go(previousEventId)}
        >
          ← Older
        </button>
        <button
          type="button"
          className="button button-small"
          disabled={!nextEventId}
          onClick={() => go(nextEventId)}
        >
          Newer →
        </button>
        <button
          type="button"
          className="button button-small"
          disabled={!nextEventId}
          onClick={() => setParams({})}
        >
          Latest
        </button>
      </div>
    </div>
  );
}

function EventDetails({ eventId }: { eventId: string }) {
  const result = useEvent(eventId);

  if (result.isLoading) return <Loading label="Loading event…" />;
  if (result.error) return <ErrorState error={result.error} retry={() => result.refetch()} />;
  if (!result.data) return null;

  const { event } = result.data;
  const { request, user } = event;
  return (
    <>
      <EventNavigator {...result.data} />

      <section className="panel">
        <h2>Stack trace</h2>
        {event.type && (
          <p className="exception">
            <strong>{event.type}</strong>
            {event.message && `: ${event.message}`}
          </p>
        )}
        <StackTrace frames={event.stacktrace?.frames ?? []} />
      </section>

      <div className="two-columns">
        <section className="panel">
          <h2>Event</h2>
          <KeyValue
            rows={[
              ["Level", event.level],
              ["Environment", event.environment],
              ["Release", event.release],
              ["Time", fullDate(event.timestamp)],
              ["Event ID", <code key="id">{event.eventId}</code>],
              ["SDK", event.sdk && `${event.sdk.name} ${event.sdk.version}`],
            ]}
          />
        </section>
        <section className="panel">
          <h2>User</h2>
          <KeyValue
            rows={[
              ["ID", user?.id],
              ["Email", user?.email],
              ["Username", user?.username],
              ["IP address", user?.ip],
            ]}
          />
        </section>
      </div>

      <section className="panel">
        <h2>Request</h2>
        <KeyValue
          rows={[
            ["Method", request?.method],
            ["URL", request?.url],
            ["Route", request?.route],
            ...Object.entries(request?.headers ?? {}).map(([name, value]): [string, string] => [
              name,
              value,
            ]),
          ]}
        />
      </section>

      <div className="two-columns">
        <section className="panel">
          <h2>Tags</h2>
          <KeyValue rows={Object.entries(event.tags ?? {})} />
        </section>
        <section className="panel">
          <h2>Context</h2>
          {event.context ? (
            <pre className="json">{JSON.stringify(event.context, null, 2)}</pre>
          ) : (
            <p className="muted">Nothing sent.</p>
          )}
        </section>
      </div>
    </>
  );
}

// "Member resolved this", "Pulse reopened this (regression)"
function describe(entry: Activity): string {
  const who = entry.actor?.name ?? "Pulse";
  const { from, to } = entry.data ?? {};
  switch (entry.action) {
    case "regression":
      return `${who} reopened it: the error came back after being resolved`;
    case "status_changed":
      return `${who} changed status from ${from} to ${to}`;
    case "severity_changed":
      return `${who} changed severity from ${from} to ${to}`;
    case "assigned":
      return `${who} assigned it`;
    case "unassigned":
      return `${who} unassigned it`;
    default:
      return `${who}: ${entry.action}`;
  }
}

function ActivityList({ issueId }: { issueId: string }) {
  const activity = useActivity(issueId);
  if (activity.isLoading) return <Loading />;
  if (activity.error) return <ErrorState error={activity.error} />;
  if (!activity.data?.length) return <p className="muted">No changes yet.</p>;

  return (
    <ol className="activity">
      {activity.data.map((entry) => (
        <li key={entry.id}>
          <span>{describe(entry)}</span>
          <span className="muted" title={fullDate(entry.createdAt)}>
            {timeAgo(entry.createdAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function IssuePage() {
  const { projectId = "", issueId = "" } = useParams();
  const [params] = useSearchParams();
  const detail = useIssue(issueId);

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorState error={detail.error} retry={() => detail.refetch()} />;
  if (!detail.data) return null;

  const { issue, latestEvent, environments, releases } = detail.data;
  const eventId = params.get("event") ?? latestEvent?.id;

  return (
    <>
      <nav className="breadcrumbs">
        <Link to={`/projects/${projectId}/issues`}>Issues</Link> /
      </nav>
      <header className="issue-header">
        <div>
          <h1>{issue.title}</h1>
          {issue.culprit && <p className="culprit">{issue.culprit}</p>}
          <div className="issue-meta">
            <StatusBadge status={issue.status} />
            <SeverityBadge severity={issue.severity} />
            {issue.isRegression && <RegressionBadge />}
            {issue.assignee && <span className="muted">Assigned to {issue.assignee.name}</span>}
          </div>
        </div>
        <Actions issue={issue} />
      </header>

      <div className="mini-stats">
        <Stat label="Events">{count(issue.eventCount)}</Stat>
        <Stat label="Users">{count(issue.userCount)}</Stat>
        <Stat label="First seen">
          <span title={fullDate(issue.firstSeen)}>{timeAgo(issue.firstSeen)}</span>
        </Stat>
        <Stat label="Last seen">
          <span title={fullDate(issue.lastSeen)}>{timeAgo(issue.lastSeen)}</span>
        </Stat>
      </div>

      <div className="issue-layout">
        <div className="issue-main">
          <FrequencyPanel
            path={`/issues/${issue.id}`}
            title="Events over time"
            periods={["24h", "30d"]}
          />
          {eventId ? (
            <EventDetails eventId={eventId} />
          ) : (
            <p className="muted">No events stored.</p>
          )}
        </div>
        <aside className="issue-side">
          <section className="panel">
            <h2>Environments</h2>
            <KeyValue rows={environments.map((e): [string, string] => [e.name, count(e.count)])} />
          </section>
          <section className="panel">
            <h2>Releases</h2>
            <KeyValue
              rows={releases.map((r): [string, string] => [
                r.name,
                `${count(r.count)} · last ${timeAgo(r.lastSeen)}`,
              ])}
            />
          </section>
          <section className="panel">
            <h2>Activity</h2>
            <ActivityList issueId={issue.id} />
          </section>
        </aside>
      </div>
    </>
  );
}
