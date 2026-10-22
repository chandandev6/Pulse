import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { useAcknowledgeLink, useIncidentLink } from "../api/incidents";
import { IncidentStatusBadge, SeverityBadge } from "../components/Badges";
import { Loading } from "../components/States";
import { fullDate, timeAgo } from "../format";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <div className="brand">
          <span className="brand-dot" aria-hidden="true" /> Pulse
        </div>
        {children}
      </div>
    </div>
  );
}

// Where the "Acknowledge" link in an email or SMS lands. Works without logging in:
// the token in the link proves who it was sent to. Opening the page changes nothing;
// the button does (email scanners open links, but they don't click buttons).
export function IncidentLinkPage() {
  const { incidentId = "" } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const token = params.get("token") ?? "";
  const view = useIncidentLink(incidentId, token);
  const acknowledge = useAcknowledgeLink(incidentId, token);

  if (view.isLoading) return <Loading />;
  if (view.error || !view.data) {
    return (
      <Card>
        <h1>Link not valid</h1>
        <p role="alert">
          {view.error instanceof ApiError ? view.error.message : "This link doesn't work."}
        </p>
        <Link to="/" className="button">
          Open Pulse
        </Link>
      </Card>
    );
  }

  const { incident, project, acknowledgedBy, user, needsLogin } = view.data;
  const dashboard = `/projects/${project.id}/incidents/${incident.id}`;
  const loginUrl = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;

  return (
    <Card>
      <p className="muted">{project.name}</p>
      <h1>{incident.title}</h1>
      <div className="issue-meta">
        <IncidentStatusBadge status={incident.status} />
        <SeverityBadge severity={incident.severity} />
        <span title={fullDate(incident.triggeredAt)}>
          triggered {timeAgo(incident.triggeredAt)}
        </span>
      </div>

      {incident.status === "triggered" && needsLogin && (
        <p>
          This link was sent to a team channel. <Link to={loginUrl}>Log in</Link> to acknowledge it
          as yourself.
        </p>
      )}

      {incident.status === "triggered" && !needsLogin && (
        <>
          <p>
            Acknowledging as <strong>{user?.name}</strong> tells your team you're on it and stops
            more notifications.
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={acknowledge.isPending}
            onClick={() => acknowledge.mutate()}
          >
            {acknowledge.isPending ? "Acknowledging…" : "Acknowledge"}
          </button>
        </>
      )}

      {incident.status === "acknowledged" && (
        <p role="status">
          {user && acknowledgedBy?.id === user.id ? "You" : (acknowledgedBy?.name ?? "Someone")}{" "}
          acknowledged this {incident.acknowledgedAt && timeAgo(incident.acknowledgedAt)}.
        </p>
      )}
      {incident.status === "resolved" && <p role="status">This incident is resolved.</p>}

      {acknowledge.error && (
        <p className="form-error" role="alert">
          {acknowledge.error instanceof ApiError
            ? acknowledge.error.message
            : "Something went wrong"}
        </p>
      )}

      <p>
        <Link to={dashboard}>Investigate in Pulse →</Link>
      </p>
    </Card>
  );
}
