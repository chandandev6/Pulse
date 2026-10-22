import { Link, useParams } from "react-router";
import { useProjectRole } from "../api/alerts";
import { formatMinutes, type PolicyLevel, usePolicies } from "../api/escalation";
import { useProject } from "../api/queries";
import { EmptyState, ErrorState, Loading } from "../components/States";

// "Ben, Primary (on call)"
export const describeTargets = (level: PolicyLevel) =>
  level.targets
    .map((target) => (target.type === "schedule" ? `${target.name} (on call)` : target.name))
    .join(", ") || "nobody";

// The org's escalation policies
export function EscalationPoliciesPage() {
  const { projectId = "" } = useParams();
  const orgId = useProject(projectId).data?.project.orgId;
  const role = useProjectRole(projectId);
  const isAdmin = role === "owner" || role === "admin";
  const policies = usePolicies(orgId);

  return (
    <>
      <header className="page-header">
        <h1>Escalation</h1>
        {isAdmin && (
          <Link to={`/projects/${projectId}/escalation/new`} className="button button-primary">
            New policy
          </Link>
        )}
      </header>

      <section className="panel">
        {policies.isLoading && <Loading />}
        {policies.error && <ErrorState error={policies.error} retry={() => policies.refetch()} />}
        {policies.data?.length === 0 && (
          <EmptyState title="No escalation policies yet">
            <span>
              A policy says who to wake up next when nobody acknowledges an incident: first the
              on-call person, after 5 minutes their backup, then the team lead…
            </span>
          </EmptyState>
        )}
        {policies.data && policies.data.length > 0 && (
          <table className="issue-table">
            <thead>
              <tr>
                <th>Policy</th>
                <th>Levels</th>
                <th className="num">Alert rules</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.map((policy) => (
                <tr key={policy.id}>
                  <td>
                    <Link
                      className="issue-title"
                      to={`/projects/${projectId}/escalation/${policy.id}`}
                    >
                      {policy.name}
                    </Link>
                    {policy.repeatCount > 0 && (
                      <div className="issue-meta">
                        <span>
                          repeats {policy.repeatCount} time{policy.repeatCount === 1 ? "" : "s"}
                        </span>
                      </div>
                    )}
                  </td>
                  <td>
                    <ol className="level-summary">
                      {policy.levels.map((level) => (
                        <li key={level.id}>
                          {describeTargets(level)}{" "}
                          <span className="muted">· {formatMinutes(level.timeoutMinutes)}</span>
                        </li>
                      ))}
                    </ol>
                  </td>
                  <td className="num">{policy.ruleCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
