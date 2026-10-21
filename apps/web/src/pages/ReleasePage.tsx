import { Link, useParams } from "react-router";
import { useRelease } from "../api/releases";
import { IssueTable } from "../components/IssueTable";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useEnvironment } from "../environment";
import { count, fullDate, timeAgo } from "../format";

// One release: did it introduce new problems, and what was broken in it?
export function ReleasePage() {
  const { projectId = "", version = "" } = useParams();
  const { environment } = useEnvironment();
  const detail = useRelease(projectId, version, environment);

  return (
    <>
      <nav className="breadcrumbs">
        <Link to={`/projects/${projectId}/releases`}>Releases</Link> /
      </nav>
      <header className="page-header">
        <h1>Release {version}</h1>
        {environment && <span className="muted">in {environment}</span>}
      </header>

      {detail.isLoading && <Loading />}
      {detail.error && <ErrorState error={detail.error} retry={() => detail.refetch()} />}
      {detail.data && (
        <>
          <div className="mini-stats">
            <div className="mini-stat">
              <div className="mini-stat-label">New issues</div>
              <div className="mini-stat-value">{count(detail.data.newIssues.length)}</div>
            </div>
            <div className="mini-stat">
              <div className="mini-stat-label">Events</div>
              <div className="mini-stat-value">{count(detail.data.release.eventCount)}</div>
            </div>
            <div className="mini-stat">
              <div className="mini-stat-label">Affected users</div>
              <div className="mini-stat-value">{count(detail.data.release.affectedUsers)}</div>
            </div>
            <div className="mini-stat">
              <div className="mini-stat-label">First seen</div>
              <div className="mini-stat-value" title={fullDate(detail.data.release.firstSeen)}>
                {timeAgo(detail.data.release.firstSeen)}
              </div>
            </div>
          </div>

          <section className="panel">
            <h2>New in this release</h2>
            {detail.data.newIssues.length === 0 ? (
              <EmptyState title="No new issues">
                <span>Everything broken here was already broken before. 🎉</span>
              </EmptyState>
            ) : (
              <IssueTable issues={detail.data.newIssues} />
            )}
          </section>

          <section className="panel">
            <h2>All issues seen in this release</h2>
            {detail.data.issues.length === 0 ? (
              <EmptyState title={environment ? `No events in ${environment}` : "No events"} />
            ) : (
              <table className="issue-table">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th className="num">Events in {version}</th>
                    <th>Introduced in</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.issues.map(({ issue, events }) => (
                    <tr key={issue.id}>
                      <td>
                        <Link
                          className="issue-title"
                          to={`/projects/${projectId}/issues/${issue.id}`}
                        >
                          {issue.title}
                        </Link>
                      </td>
                      <td className="num">{count(events)}</td>
                      <td>{issue.firstRelease ?? <span className="muted">unknown</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}
