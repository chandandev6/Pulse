import { Link } from "react-router";
import type { Issue } from "../api/types";
import { count, fullDate, timeAgo } from "../format";
import { RegressionBadge, SeverityBadge, StatusBadge } from "./Badges";

export function IssueTable({ issues, compact = false }: { issues: Issue[]; compact?: boolean }) {
  return (
    <table className="issue-table">
      <thead>
        <tr>
          <th>Issue</th>
          <th className="num">Events</th>
          <th className="num">Users</th>
          {!compact && <th>Last seen</th>}
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <tr key={issue.id}>
            <td>
              <Link className="issue-title" to={`/projects/${issue.projectId}/issues/${issue.id}`}>
                {issue.title}
              </Link>
              <div className="issue-meta">
                <SeverityBadge severity={issue.severity} />
                {issue.status !== "unresolved" && <StatusBadge status={issue.status} />}
                {issue.isRegression && <RegressionBadge />}
                {issue.culprit && <span className="culprit">{issue.culprit}</span>}
                {compact && <span title={fullDate(issue.lastSeen)}>{timeAgo(issue.lastSeen)}</span>}
              </div>
            </td>
            <td className="num">{count(issue.eventCount)}</td>
            <td className="num">{count(issue.userCount)}</td>
            {!compact && <td title={fullDate(issue.lastSeen)}>{timeAgo(issue.lastSeen)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
