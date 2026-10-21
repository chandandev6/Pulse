import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useReleases } from "../api/releases";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { count, fullDate, timeAgo } from "../format";

export const releaseUrl = (projectId: string, version: string) =>
  `/projects/${projectId}/releases/${encodeURIComponent(version)}`;

export function ReleasesPage() {
  const { projectId = "" } = useParams();
  const releases = useReleases(projectId);
  const navigate = useNavigate();
  const versions = releases.data?.map((r) => r.version) ?? [];
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  // Default comparison: the previous release against the newest one
  const pickA = a || versions[1] || "";
  const pickB = b || versions[0] || "";

  const compare = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams({ a: pickA, b: pickB });
    navigate(`/projects/${projectId}/releases/compare?${params}`);
  };

  return (
    <>
      <header className="page-header">
        <h1>Releases</h1>
        {versions.length >= 2 && (
          <form className="compare-form" onSubmit={compare}>
            <select aria-label="Release A" value={pickA} onChange={(e) => setA(e.target.value)}>
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <span className="muted">vs</span>
            <select aria-label="Release B" value={pickB} onChange={(e) => setB(e.target.value)}>
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button type="submit" className="button" disabled={pickA === pickB}>
              Compare
            </button>
          </form>
        )}
      </header>

      <section className="panel">
        {releases.isLoading && <Loading />}
        {releases.error && <ErrorState error={releases.error} retry={() => releases.refetch()} />}
        {releases.data?.length === 0 && (
          <EmptyState title="No releases yet">
            <span>
              Send <code>release</code> with your events (for example{" "}
              <code>Pulse.init(&#123; release: "1.0.0" &#125;)</code>) to see them here.
            </span>
          </EmptyState>
        )}
        {releases.data && releases.data.length > 0 && (
          <table className="issue-table">
            <thead>
              <tr>
                <th>Version</th>
                <th className="num">New issues</th>
                <th className="num">Events</th>
                <th>First seen</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {releases.data.map((release) => (
                <tr key={release.version}>
                  <td>
                    <Link className="issue-title" to={releaseUrl(projectId, release.version)}>
                      {release.version}
                    </Link>
                  </td>
                  <td className="num">
                    {release.newIssues > 0 ? (
                      <span className="badge badge-regression">{release.newIssues} new</span>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td className="num">{count(release.eventCount)}</td>
                  <td title={fullDate(release.firstSeen)}>{timeAgo(release.firstSeen)}</td>
                  <td title={fullDate(release.lastSeen)}>{timeAgo(release.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
