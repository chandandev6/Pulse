import { Link, useParams, useSearchParams } from "react-router";
import { type ComparedIssue, useCompare, useReleases } from "../api/releases";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useEnvironment } from "../environment";
import { count } from "../format";

function CompareTable({
  projectId,
  rows,
  a,
  b,
  empty,
}: {
  projectId: string;
  rows: ComparedIssue[];
  a: string;
  b: string;
  empty: string;
}) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="issue-table">
      <thead>
        <tr>
          <th>Issue</th>
          <th className="num">Events in {a}</th>
          <th className="num">Events in {b}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ issue, countA, countB }) => (
          <tr key={issue.id}>
            <td>
              <Link className="issue-title" to={`/projects/${projectId}/issues/${issue.id}`}>
                {issue.title}
              </Link>
            </td>
            <td className="num">{count(countA)}</td>
            <td className="num">{count(countB)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// "What changed between 1.4 and 1.5?" New problems, fixed problems, still-broken problems
export function ComparePage() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const a = params.get("a") ?? "";
  const b = params.get("b") ?? "";
  const { environment } = useEnvironment();
  const releases = useReleases(projectId);
  const comparison = useCompare(projectId, a, b, environment);
  const versions = releases.data?.map((r) => r.version) ?? [];

  const pick = (key: "a" | "b", value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <nav className="breadcrumbs">
        <Link to={`/projects/${projectId}/releases`}>Releases</Link> /
      </nav>
      <header className="page-header">
        <h1>Compare releases</h1>
        <div className="compare-form">
          <select aria-label="Release A" value={a} onChange={(e) => pick("a", e.target.value)}>
            {[a, ...versions.filter((v) => v !== a)].map((v) => (
              <option key={v} value={v}>
                {v || "Pick a release"}
              </option>
            ))}
          </select>
          <span className="muted">vs</span>
          <select aria-label="Release B" value={b} onChange={(e) => pick("b", e.target.value)}>
            {[b, ...versions.filter((v) => v !== b)].map((v) => (
              <option key={v} value={v}>
                {v || "Pick a release"}
              </option>
            ))}
          </select>
        </div>
      </header>

      {(!a || !b || a === b) && <EmptyState title="Pick two different releases to compare" />}
      {comparison.isLoading && <Loading />}
      {comparison.error && (
        <ErrorState error={comparison.error} retry={() => comparison.refetch()} />
      )}
      {comparison.data && (
        <>
          <section className="panel">
            <h2>New in {b}</h2>
            <CompareTable
              projectId={projectId}
              rows={comparison.data.onlyInB}
              a={a}
              b={b}
              empty={`Nothing new in ${b}.`}
            />
          </section>
          <section className="panel">
            <h2>
              Gone in {b} (only seen in {a})
            </h2>
            <CompareTable
              projectId={projectId}
              rows={comparison.data.onlyInA}
              a={a}
              b={b}
              empty="Nothing went away."
            />
          </section>
          <section className="panel">
            <h2>In both</h2>
            <CompareTable
              projectId={projectId}
              rows={comparison.data.inBoth}
              a={a}
              b={b}
              empty="No issue appears in both."
            />
          </section>
        </>
      )}
    </>
  );
}
