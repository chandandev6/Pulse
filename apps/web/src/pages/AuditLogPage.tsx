import { useParams, useSearchParams } from "react-router";
import { useAuditLog } from "../api/audit";
import { ApiError } from "../api/client";
import { useProject } from "../api/queries";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fullDate, timeAgo } from "../format";

// The same list as the API's AUDIT_ACTIONS, grouped for the filter
const ACTION_GROUPS: Record<string, string[]> = {
  Members: ["member.added", "member.role_changed", "member.removed"],
  Projects: ["project.created", "project.updated", "project.deleted", "org.updated"],
  Keys: ["key.rotated", "key.revoked"],
  "Alert rules": ["alert_rule.created", "alert_rule.updated", "alert_rule.deleted"],
  Escalation: [
    "escalation_policy.created",
    "escalation_policy.updated",
    "escalation_policy.deleted",
  ],
  Schedules: ["schedule.created", "schedule.updated", "schedule.deleted"],
  Channels: ["channel.created", "channel.updated", "channel.deleted"],
};

// "member.role_changed" → "Member role changed"
const actionLabel = (action: string) => {
  const text = action.replace(".", " ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// The extra details, e.g. "name: Checkout · fields: retentionDays"
function details(data: Record<string, unknown>) {
  return Object.entries(data)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join(" · ");
}

export function AuditLogPage() {
  const { projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const action = searchParams.get("action") ?? "";
  const orgId = useProject(projectId).data?.project.orgId;
  const log = useAuditLog(orgId, action);

  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];
  const forbidden = log.error instanceof ApiError && log.error.status === 403;

  return (
    <>
      <header className="page-header">
        <h1>Audit log</h1>
        <label className="inline-label">
          Action
          <select
            value={action}
            onChange={(e) => setSearchParams(e.target.value ? { action: e.target.value } : {})}
          >
            <option value="">All actions</option>
            {Object.entries(ACTION_GROUPS).map(([group, actions]) => (
              <optgroup key={group} label={group}>
                {actions.map((name) => (
                  <option key={name} value={name}>
                    {actionLabel(name)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </header>

      {!orgId || log.isLoading ? (
        <Loading />
      ) : forbidden ? (
        <EmptyState title="Admins only">
          Ask an admin or owner of this organization to see who changed what.
        </EmptyState>
      ) : log.error ? (
        <ErrorState error={log.error} retry={() => log.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet">
          Changes to members, keys, alert rules, schedules and policies show up here.
        </EmptyState>
      ) : (
        <section className="panel">
          <table className="issue-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td title={fullDate(entry.createdAt)}>{timeAgo(entry.createdAt)}</td>
                  <td>
                    {entry.actor ? entry.actor.name : <span className="muted">Deleted user</span>}
                  </td>
                  <td>
                    <strong>{actionLabel(entry.action)}</strong>
                    <div className="audit-details">{details(entry.data)}</div>
                  </td>
                  <td>
                    <code>{entry.ip ?? "—"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {log.hasNextPage && (
            <button
              type="button"
              className="button load-more"
              disabled={log.isFetchingNextPage}
              onClick={() => log.fetchNextPage()}
            >
              {log.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </section>
      )}
    </>
  );
}
