import { Link, useParams } from "react-router";
import { useProject, useStats, useTopIssues } from "../api/queries";
import { FrequencyPanel } from "../components/FrequencyChart";
import { IssueTable } from "../components/IssueTable";
import { StatCard } from "../components/StatCard";
import { EmptyState, ErrorState, Loading } from "../components/States";

function IssueList({
  projectId,
  sort,
  title,
}: {
  projectId: string;
  sort: "last_seen" | "event_count";
  title: string;
}) {
  const issues = useTopIssues(projectId, { sort, status: "unresolved", limit: 5 });
  return (
    <section className="panel">
      <h2>{title}</h2>
      {issues.isLoading && <Loading />}
      {issues.error && <ErrorState error={issues.error} retry={() => issues.refetch()} />}
      {issues.data?.length === 0 && (
        <EmptyState title="No open issues">
          <span>Nothing is broken right now. 🎉</span>
        </EmptyState>
      )}
      {issues.data && issues.data.length > 0 && <IssueTable issues={issues.data} compact />}
    </section>
  );
}

// The project's health at a glance
export function OverviewPage() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);
  const stats = useStats(projectId);

  return (
    <>
      <header className="page-header">
        <h1>{project.data?.project.name ?? "Overview"}</h1>
        <Link to={`/projects/${projectId}/issues`} className="button">
          All issues →
        </Link>
      </header>

      {stats.isLoading && <Loading />}
      {stats.error && <ErrorState error={stats.error} retry={() => stats.refetch()} />}
      {stats.data && (
        <div className="stat-grid">
          <StatCard label="Active issues" value={stats.data.activeIssues} />
          <StatCard label="Critical issues" value={stats.data.criticalIssues} tone="danger" />
          <StatCard label="Events (24h)" value={stats.data.events24h} />
          <StatCard label="Affected users (24h)" value={stats.data.users24h} />
        </div>
      )}

      <FrequencyPanel path={`/projects/${projectId}`} title="Events" periods={["24h", "14d"]} />

      <div className="two-columns">
        <IssueList projectId={projectId} sort="last_seen" title="Recent issues" />
        <IssueList projectId={projectId} sort="event_count" title="Most frequent issues" />
      </div>
    </>
  );
}
