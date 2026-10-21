import { type FormEvent, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ISSUE_PERIODS, type IssueFilters, type IssuePeriod, useIssueList } from "../api/queries";
import type { IssueSort, IssueStatus, Severity } from "../api/types";
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

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const PERIOD_LABELS: Record<IssuePeriod, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

// The filters that narrow the list (status tabs and sort are kept apart: they're not "filters")
const FILTER_KEYS = ["q", "severity", "environment", "release", "period"];

// Reads the filters from the URL, ignoring anything we don't understand,
// so a hand-edited or old link still opens a working page
function filtersFrom(params: URLSearchParams) {
  const severity = (params.get("severity") ?? "")
    .split(",")
    .filter((s): s is Severity => SEVERITIES.includes(s as Severity));
  const period = params.get("period");
  return {
    q: params.get("q") ?? "",
    severity,
    environment: params.get("environment") ?? "",
    release: params.get("release") ?? "",
    period: period && period in ISSUE_PERIODS ? (period as IssuePeriod) : undefined,
  };
}

// A text box that writes to the URL once you stop typing (or press Enter),
// instead of sending a request for every key you press
function TextFilter({
  value,
  onCommit,
  ...input
}: {
  value: string;
  onCommit: (value: string) => void;
  "aria-label": string;
  placeholder: string;
  className?: string;
  type?: string;
}) {
  const [text, setText] = useState(value);

  // The URL changed from outside (Clear filters, the back button): show that
  useEffect(() => setText(value), [value]);

  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onCommit(text.trim()), 400);
    return () => clearTimeout(timer);
  }, [text, value, onCommit]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onCommit(text.trim());
  };

  return (
    <form onSubmit={submit} className={input.className}>
      <input
        type={input.type ?? "text"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={input["aria-label"]}
        placeholder={input.placeholder}
        className={input.className ? undefined : "filter-text"}
        style={input.className ? { width: "100%" } : undefined}
      />
    </form>
  );
}

export function IssuesPage() {
  const { projectId = "" } = useParams();
  // Everything lives in the URL, so a filtered list can be bookmarked or shared
  const [params, setParams] = useSearchParams();
  const tab = (params.get("status") ?? "unresolved") as IssueStatus | "all";
  const sort = (params.get("sort") ?? "last_seen") as IssueSort;
  const filters = filtersFrom(params);
  const hasFilters = FILTER_KEYS.some((key) => params.has(key));

  const query: IssueFilters = {
    sort,
    status: tab === "all" ? undefined : tab,
    q: filters.q || undefined,
    severity: filters.severity.length ? filters.severity : undefined,
    environment: filters.environment || undefined,
    release: filters.release || undefined,
    period: filters.period,
  };
  const list = useIssueList(projectId, query);
  const issues = list.data?.pages.flatMap((page) => page.issues) ?? [];

  // An empty value removes the key, so URLs only carry filters that are on
  const update = (key: string, value: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const toggleSeverity = (severity: Severity) => {
    const on = filters.severity.includes(severity);
    const next = on
      ? filters.severity.filter((s) => s !== severity)
      : [...filters.severity, severity];
    // Keep a fixed order so the same filter always makes the same URL
    update("severity", SEVERITIES.filter((s) => next.includes(s)).join(","));
  };

  const clearFilters = () => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of FILTER_KEYS) next.delete(key);
        return next;
      },
      { replace: true },
    );
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

      <div className="filters">
        <TextFilter
          type="search"
          className="search"
          value={filters.q}
          onCommit={(value) => update("q", value)}
          aria-label="Search issues"
          placeholder="Search errors, e.g. cannot read properties"
        />
        <TextFilter
          value={filters.environment}
          onCommit={(value) => update("environment", value)}
          aria-label="Environment"
          placeholder="Environment"
        />
        <TextFilter
          value={filters.release}
          onCommit={(value) => update("release", value)}
          aria-label="Release"
          placeholder="Release"
        />
        <select
          aria-label="Time range"
          value={filters.period ?? ""}
          onChange={(e) => update("period", e.target.value)}
        >
          <option value="">Any time</option>
          {Object.entries(PERIOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <fieldset className="chips">
          <legend className="sr-only">Severity</legend>
          {SEVERITIES.map((severity) => (
            <button
              key={severity}
              type="button"
              className="chip"
              aria-pressed={filters.severity.includes(severity)}
              onClick={() => toggleSeverity(severity)}
            >
              {severity}
            </button>
          ))}
        </fieldset>
        {hasFilters && (
          <button type="button" className="link-button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

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
        {list.isSuccess && issues.length === 0 && hasFilters && (
          <EmptyState title="No issues match these filters">
            <button type="button" className="link-button" onClick={clearFilters}>
              Clear filters
            </button>
          </EmptyState>
        )}
        {list.isSuccess && issues.length === 0 && !hasFilters && (
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
