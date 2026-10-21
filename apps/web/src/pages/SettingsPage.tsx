import { useState } from "react";
import { Link, useParams } from "react-router";
import { useProject } from "../api/queries";
import { ErrorState, Loading } from "../components/States";
import { fullDate, timeAgo } from "../format";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the text is still selectable
    }
  };
  return (
    <button type="button" className="button button-small" onClick={copy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="code-block">
      <pre>
        <code>{children}</code>
      </pre>
      <CopyButton text={children} />
    </div>
  );
}

// Everything needed to start sending errors from an app
export function SettingsPage() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);

  if (project.isLoading) return <Loading />;
  if (project.error) return <ErrorState error={project.error} retry={() => project.refetch()} />;
  if (!project.data) return null;

  const { keys } = project.data;
  const active = keys.find((key) => !key.revokedAt);

  return (
    <>
      <header className="page-header">
        <h1>Settings · {project.data.project.name}</h1>
      </header>

      <section className="panel">
        <h2>Your DSN</h2>
        <p className="muted">
          The address your app sends errors to. It's safe to ship inside your app's code: it can
          only send events, never read them.
        </p>
        {active ? (
          <Code>{active.dsn}</Code>
        ) : (
          <p className="form-error">No active key. Rotate one in the API.</p>
        )}
      </section>

      {active && (
        <section className="panel">
          <h2>Set up the SDK</h2>
          <Code>{`npm install @pulse/sdk`}</Code>
          <Code>{`import Pulse from "@pulse/sdk";

Pulse.init({
  dsn: "${active.dsn}",
  environment: "production",
  release: "1.0.0",
});`}</Code>
          <p className="muted">Or send a test event right now:</p>
          <Code>{`curl -X POST ${new URL(active.dsn).origin}/api/${projectId}/events \\
  -H "content-type: application/json" \\
  -H "x-pulse-key: ${active.publicKey}" \\
  -d '{"message": "Hello from Pulse"}'`}</Code>
        </section>
      )}

      <section className="panel">
        <h2>Alert rules</h2>
        <p className="muted">Decide which errors should open an incident and wake someone up.</p>
        <Link to={`/projects/${projectId}/alerts`} className="button">
          Manage alert rules →
        </Link>
      </section>

      <section className="panel">
        <h2>Keys</h2>
        <table className="issue-table">
          <thead>
            <tr>
              <th>Public key</th>
              <th>Created</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <code>{key.publicKey}</code>
                </td>
                <td title={fullDate(key.createdAt)}>{timeAgo(key.createdAt)}</td>
                <td>
                  {key.revokedAt ? (
                    <span className="badge badge-ignored">Revoked</span>
                  ) : (
                    <span className="badge badge-resolved">Active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
