import { Link, useParams } from "react-router";
import { useProject, useStats, useTopIssues } from "../api/queries";
import { useOnCallNow } from "../api/schedules";
import { FrequencyPanel } from "../components/FrequencyChart";
import { IssueTable } from "../components/IssueTable";
import { OnCallWidget } from "../components/OnCall";
import { StatCard } from "../components/StatCard";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useEnvironment } from "../environment";

function IssueList({
  projectId,
  sort,
  title,
  environment,
  totalUsers,
}: {
  projectId: string;
  sort: "last_seen" | "event_count";
  title: string;
  environment: string;
  totalUsers?: number;
}) {
  const issues = useTopIssues(projectId, {
    sort,
    status: "unresolved",
    limit: 5,
    environment: environment || undefined,
  });
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
      {issues.data && issues.data.length > 0 && (
        <IssueTable issues={issues.data} compact totalUsers={totalUsers} />
      )}
    </section>
  );
}

// The project's health at a glance
export function OverviewPage() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);
  const { environment } = useEnvironment();
  const stats = useStats(projectId, environment);
  const totalUsers = stats.data?.totalUsers;
  const oncall = useOnCallNow(project.data?.project.orgId);

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

      {oncall.data && oncall.data.length > 0 && (
        <section className="panel">
          <h2>On call now</h2>
          <OnCallWidget
            oncall={oncall.data}
            isLoading={false}
            linkTo={(id) => `/projects/${projectId}/schedules/${id}`}
          />
        </section>
      )}

      <FrequencyPanel path={`/projects/${projectId}`} title="Events" periods={["24h", "14d"]} />

      <div className="two-columns">
        <IssueList
          projectId={projectId}
          sort="last_seen"
          title="Recent issues"
          environment={environment}
          totalUsers={totalUsers}
        />
        <IssueList
          projectId={projectId}
          sort="event_count"
          title="Most frequent issues"
          environment={environment}
          totalUsers={totalUsers}
        />
      </div>
    </>
  );
}
