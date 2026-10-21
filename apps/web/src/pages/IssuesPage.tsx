import { Link, useParams, useSearchParams } from "react-router";
import { useIssueList } from "../api/queries";
import type { IssueSort, IssueStatus } from "../api/types";
import { IssueTable } from "../components/IssueTable";
import { EmptyState, ErrorState, Loading } from "../components/States";

const TABS: [IssueStatus | "all", string][] = [
  ["unresolved", "Unresolved"],
  ["resolved", "Resolved"],
  ["ignored", "Ignored"],
  ["all", "All"],
];

const SORTS: [IssueSort, string][] = [
  ["last_seen", "Last seen"],
  ["first_seen", "First seen"],
  ["event_count", "Events"],
  ["user_count", "Users"],
];

export function IssuesPage() {
  const { projectId = "" } = useParams();
  // Filters live in the URL, so a filtered list can be bookmarked or shared
  const [params, setParams] = useSearchParams();
  const tab = (params.get("status") ?? "unresolved") as IssueStatus | "all";
  const sort = (params.get("sort") ?? "last_seen") as IssueSort;

  const list = useIssueList(projectId, { sort, status: tab === "all" ? undefined : tab });
  const issues = list.data?.pages.flatMap((page) => page.issues) ?? [];

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <header className="page-header">
        <h1>Issues</h1>
        <label className="inline-label">
          Sort by
          <select value={sort} onChange={(e) => update("sort", e.target.value)}>
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "tab active" : "tab"}
            onClick={() => update("status", value)}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="panel">
        {list.isLoading && <Loading />}
        {list.error && <ErrorState error={list.error} retry={() => list.refetch()} />}
        {list.isSuccess && issues.length === 0 && (
          <EmptyState title={tab === "unresolved" ? "No open issues" : "Nothing here"}>
            <span>
              Not seeing errors you expected? Check the{" "}
              <Link to={`/projects/${projectId}/settings`}>SDK setup</Link>.
            </span>
          </EmptyState>
        )}
        {issues.length > 0 && <IssueTable issues={issues} />}
        {list.hasNextPage && (
          <button
            type="button"
            className="button load-more"
            onClick={() => list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </>
  );
}
