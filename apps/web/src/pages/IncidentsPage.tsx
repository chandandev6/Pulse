import { Link, useParams, useSearchParams } from "react-router";
import { type Incident, type IncidentStatus, useIncidents } from "../api/incidents";
import { IncidentStatusBadge, SeverityBadge } from "../components/Badges";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fullDate, timeAgo } from "../format";

const TABS: [IncidentStatus | "", string][] = [
  ["triggered", "Needs someone"],
  ["acknowledged", "Acknowledged"],
  ["resolved", "Resolved"],
  ["", "All"],
];

// "Taken by Ada", "Waiting for Ben (on call)", "Waiting for anyone"
function whoHasIt(incident: Incident) {
  if (incident.status === "resolved")
    return `Resolved by ${incident.resolvedBy?.name ?? "someone"}`;
  if (incident.status === "acknowledged") {
    return `Taken by ${incident.acknowledgedBy?.name ?? "someone"}`;
  }
  return incident.responder
    ? `Waiting for ${incident.responder.name} (on call)`
    : "Waiting for anyone";
}

// Every incident of the project. The status is in the URL, so the tab survives a reload.
export function IncidentsPage() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "triggered") as IncidentStatus | "";
  const incidents = useIncidents(projectId, status);

  return (
    <>
      <header className="page-header">
        <h1>Incidents</h1>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={status === value}
            className={status === value ? "tab active" : "tab"}
            onClick={() => setParams({ status: value })}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="panel">
        {incidents.isLoading && <Loading />}
        {incidents.error && (
          <ErrorState error={incidents.error} retry={() => incidents.refetch()} />
        )}
        {incidents.data?.length === 0 && (
          <EmptyState title={status === "triggered" ? "Nothing needs attention" : "No incidents"}>
            <span>
              Alert rules open incidents.{" "}
              <Link to={`/projects/${projectId}/alerts`}>See rules</Link>
            </span>
          </EmptyState>
        )}
        {incidents.data && incidents.data.length > 0 && (
          <table className="issue-table">
            <thead>
              <tr>
                <th>Incident</th>
                <th>Status</th>
                <th>Who</th>
                <th>Triggered</th>
              </tr>
            </thead>
            <tbody>
              {incidents.data.map((incident) => (
                <tr key={incident.id}>
                  <td>
                    <Link
                      className="issue-title"
                      to={`/projects/${projectId}/incidents/${incident.id}`}
                    >
                      {incident.title}
                    </Link>
                    <div className="issue-meta">
                      <SeverityBadge severity={incident.severity} />
                      <span>{incident.rule?.name ?? "deleted rule"}</span>
                    </div>
                  </td>
                  <td>
                    <IncidentStatusBadge status={incident.status} />
                  </td>
                  <td>{whoHasIt(incident)}</td>
                  <td title={fullDate(incident.triggeredAt)}>{timeAgo(incident.triggeredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
