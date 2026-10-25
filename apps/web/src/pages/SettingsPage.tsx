import { useState } from "react";
import { Link, useParams } from "react-router";
import { useProjectRole } from "../api/alerts";
import { ApiError } from "../api/client";
import { useProject, useUpdateProject } from "../api/queries";
import { useSchedules } from "../api/schedules";
import type { Project, ProjectSettings } from "../api/types";
import { SourceMapsPanel } from "../components/SourceMapsPanel";
import { ErrorState, Loading } from "../components/States";
import { TeamPanel } from "../components/TeamPanel";
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

// F13: who gets woken up first when this project has an incident
function OnCallSetting({ project }: { project: Project }) {
  const schedules = useSchedules(project.orgId);
  const update = useUpdateProject(project.id);
  const role = useProjectRole(project.id);
  const canEdit = role === "owner" || role === "admin";

  return (
    <section className="panel">
      <h2>On-call</h2>
      <p className="muted">
        Whoever is on call on this schedule is the first responder for new incidents. With no
        schedule, every member is notified.
      </p>
      <label className="inline-label">
        Schedule
        <select
          value={project.onCallScheduleId ?? ""}
          disabled={!canEdit || schedules.isLoading || update.isPending}
          onChange={(e) => update.mutate({ onCallScheduleId: e.target.value || null })}
        >
          <option value="">No schedule: notify everyone</option>
          {schedules.data?.map((schedule) => (
            <option key={schedule.id} value={schedule.id}>
              {schedule.name}
              {schedule.onCall ? ` (now: ${schedule.onCall.user.name})` : ""}
            </option>
          ))}
        </select>
      </label>
      {schedules.data?.length === 0 && (
        <p className="muted">
          No schedules yet. <Link to={`/projects/${project.id}/schedules`}>Create one</Link>
        </p>
      )}
      {update.error && (
        <p className="form-error" role="alert">
          {update.error instanceof ApiError ? update.error.message : "Couldn't save"}
        </p>
      )}
    </section>
  );
}

// F15: how much the project may send, how long events are kept, what is scrubbed
function DataSettings({ project, eventsThisMonth }: { project: Project; eventsThisMonth: number }) {
  const update = useUpdateProject(project.id);
  const role = useProjectRole(project.id);
  const canEdit = role === "owner" || role === "admin";
  const [form, setForm] = useState({
    rateLimitPerMinute: String(project.rateLimitPerMinute),
    monthlyQuota: project.monthlyQuota === null ? "" : String(project.monthlyQuota),
    retentionDays: String(project.retentionDays),
    scrubData: project.scrubData,
    scrubFields: project.scrubFields.join(", "),
    scrubIpAddresses: project.scrubIpAddresses,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const changes: ProjectSettings = {
      rateLimitPerMinute: Number(form.rateLimitPerMinute),
      monthlyQuota: form.monthlyQuota.trim() ? Number(form.monthlyQuota) : null,
      retentionDays: Number(form.retentionDays),
      scrubData: form.scrubData,
      scrubFields: form.scrubFields
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean),
      scrubIpAddresses: form.scrubIpAddresses,
    };
    update.mutate(changes);
  };

  const quota = project.monthlyQuota;
  return (
    <form className="panel" onSubmit={save}>
      <h2>Data & limits</h2>
      <p className="muted">
        This month: <strong>{eventsThisMonth.toLocaleString()}</strong>
        {quota !== null ? ` of ${quota.toLocaleString()} events` : " events (no quota)"}
      </p>
      <fieldset disabled={!canEdit || update.isPending} className="plain-fieldset">
        <div className="form-row">
          <label className="inline-label">
            Events per minute
            <input
              type="number"
              min={1}
              max={100000}
              required
              value={form.rateLimitPerMinute}
              onChange={(e) => set("rateLimitPerMinute", e.target.value)}
            />
          </label>
          <label className="inline-label">
            Monthly quota
            <input
              type="number"
              min={1}
              placeholder="No quota"
              value={form.monthlyQuota}
              onChange={(e) => set("monthlyQuota", e.target.value)}
            />
          </label>
          <label className="inline-label">
            Keep events for (days)
            <input
              type="number"
              min={1}
              max={3650}
              required
              value={form.retentionDays}
              onChange={(e) => set("retentionDays", e.target.value)}
            />
          </label>
        </div>
        <p className="muted">
          Over a limit, ingestion answers 429 and the SDK backs off. Older events are deleted every
          night; issues keep their counts.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.scrubData}
            onChange={(e) => set("scrubData", e.target.checked)}
          />
          Scrub sensitive data (passwords, tokens, cookies, card numbers) before storing events
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.scrubIpAddresses}
            disabled={!form.scrubData}
            onChange={(e) => set("scrubIpAddresses", e.target.checked)}
          />
          Also remove users' IP addresses
        </label>
        <label className="inline-label">
          Extra fields to scrub (comma separated)
          <input
            value={form.scrubFields}
            disabled={!form.scrubData}
            placeholder="e.g. iban, national_id"
            onChange={(e) => set("scrubFields", e.target.value)}
          />
        </label>
        {canEdit && (
          <div className="form-row">
            <button type="submit" className="button button-primary">
              {update.isPending ? "Saving…" : "Save"}
            </button>
            {update.isSuccess && <span className="muted">Saved</span>}
          </div>
        )}
      </fieldset>
      {update.error && (
        <p className="form-error" role="alert">
          {update.error instanceof ApiError ? update.error.message : "Couldn't save"}
        </p>
      )}
    </form>
  );
}

// Everything needed to start sending errors from an app
export function SettingsPage() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);
  const role = useProjectRole(projectId);

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

      <OnCallSetting project={project.data.project} />

      <TeamPanel orgId={project.data.project.orgId} role={role} />

      <SourceMapsPanel
        projectId={projectId}
        origin={active ? new URL(active.dsn).origin : window.location.origin}
        isAdmin={role === "owner" || role === "admin"}
      />

      <DataSettings
        key={project.data.project.id}
        project={project.data.project}
        eventsThisMonth={project.data.usage?.eventsThisMonth ?? 0}
      />

      <section className="panel">
        <h2>Audit log</h2>
        <p className="muted">Who changed members, keys, rules and policies in this organization.</p>
        <Link to={`/projects/${projectId}/audit-log`} className="button">
          View audit log →
        </Link>
      </section>

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
