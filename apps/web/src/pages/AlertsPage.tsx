import { Link, useParams } from "react-router";
import { describeCondition, useAlertRules, useProjectRole } from "../api/alerts";
import { useIncidents } from "../api/incidents";
import { IncidentStatusBadge, SeverityBadge } from "../components/Badges";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fullDate, timeAgo } from "../format";

// The project's alert rules and the incidents they opened
export function AlertsPage() {
  const { projectId = "" } = useParams();
  const rules = useAlertRules(projectId);
  const incidents = useIncidents(projectId);
  const role = useProjectRole(projectId);
  const canEdit = role === "owner" || role === "admin";

  return (
    <>
      <header className="page-header">
        <h1>Alerts</h1>
        {canEdit && (
          <Link to={`/projects/${projectId}/alerts/new`} className="button button-primary">
            New alert rule
          </Link>
        )}
      </header>

      <section className="panel">
        <h2>Rules</h2>
        {rules.isLoading && <Loading />}
        {rules.error && <ErrorState error={rules.error} retry={() => rules.refetch()} />}
        {rules.data?.length === 0 && (
          <EmptyState title="No alert rules yet">
            <span>
              Rules decide which errors open an incident, for example "a new issue appears" or "more
              than 100 events in 10 minutes".
            </span>
          </EmptyState>
        )}
        {rules.data && rules.data.length > 0 && (
          <table className="issue-table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>When</th>
                <th className="num">Open incidents</th>
                <th>Last fired</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <Link className="issue-title" to={`/projects/${projectId}/alerts/${rule.id}`}>
                      {rule.name}
                    </Link>
                    <div className="issue-meta">
                      <SeverityBadge severity={rule.severity} />
                      {!rule.enabled && <span className="badge badge-ignored">Off</span>}
                      <span>{rule.environment ?? "All environments"}</span>
                    </div>
                  </td>
                  <td>
                    {rule.conditions
                      .map(describeCondition)
                      .join(rule.match === "all" ? " and " : " or ")}
                  </td>
                  <td className="num">{rule.openIncidents ?? 0}</td>
                  <td>
                    {rule.lastTriggeredAt ? (
                      <span title={fullDate(rule.lastTriggeredAt)}>
                        {timeAgo(rule.lastTriggeredAt)}
                      </span>
                    ) : (
                      <span className="muted">never</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Recent incidents</h2>
          <Link to={`/projects/${projectId}/incidents`}>All incidents →</Link>
        </div>
        {incidents.isLoading && <Loading />}
        {incidents.error && (
          <ErrorState error={incidents.error} retry={() => incidents.refetch()} />
        )}
        {incidents.data?.length === 0 && <p className="muted">No incidents yet.</p>}
        {incidents.data && incidents.data.length > 0 && (
          <table className="issue-table">
            <thead>
              <tr>
                <th>Incident</th>
                <th>Rule</th>
                <th>Status</th>
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
                    </div>
                  </td>
                  <td>{incident.rule?.name ?? <span className="muted">deleted rule</span>}</td>
                  <td>
                    <IncidentStatusBadge status={incident.status} />
                  </td>
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
