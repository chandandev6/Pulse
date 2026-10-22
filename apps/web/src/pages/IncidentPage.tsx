import { useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  type EscalationTarget,
  type IncidentDetail,
  type TimelineStep,
  useIncident,
  useIncidentActions,
} from "../api/incidents";
import type { DeliveryStatus } from "../api/notifications";
import { IncidentStatusBadge, SeverityBadge, StatusBadge } from "../components/Badges";
import { KeyValue } from "../components/KeyValue";
import { ErrorState, Loading } from "../components/States";
import { fullDate, timeAgo } from "../format";

const DELIVERY_CLASS: Record<DeliveryStatus, string> = {
  pending: "badge",
  sent: "badge badge-resolved",
  failed: "badge severity-critical",
  skipped: "badge badge-ignored",
};

// "Ben, Cara (on call on Primary)"
const names = (targets: EscalationTarget[]) =>
  targets
    .map((t) => (t.schedule ? `${t.name} (on call on ${t.schedule.name})` : t.name))
    .join(", ") || "nobody";

// One line per step: "Ada acknowledged it from the email link"
export function describeStep(step: TimelineStep): string {
  const who = step.actor?.name ?? "Pulse";
  switch (step.kind) {
    case "triggered":
      return `Opened by alert rule "${step.data.ruleName}"`;
    case "notified": {
      const { responder, everyone, channels, escalation } = step.data;
      const sent = `${channels} channel${channels === 1 ? "" : "s"}`;
      if (escalation) {
        return everyone
          ? `Level 1 of "${escalation.policy.name}" (${names(escalation.targets)}) can't be reached, so every member was notified (${sent})`
          : `Notified level 1 of "${escalation.policy.name}": ${names(escalation.targets)} (${sent})`;
      }
      if (!responder) return `Nobody was on call: every member was notified (${sent})`;
      const role = responder.source === "override" ? "covering on call" : "on call";
      return everyone
        ? `${responder.name} (${role}) has no channel for this, so every member was notified (${sent})`
        : `Notified ${responder.name} (${role}) and team channels (${sent})`;
    }
    case "escalated": {
      const { level, pass, targets, channels } = step.data;
      const again = pass > 1 ? ` (round ${pass})` : "";
      return `Nobody acknowledged in time: escalated to level ${level}${again}, ${names(targets)} (${channels} channel${channels === 1 ? "" : "s"})`;
    }
    case "exhausted":
      return `Every level was tried${step.data.passes > 1 ? ` ${step.data.passes} times` : ""} and nobody acknowledged: escalation stopped`;
    case "acknowledged":
      return `${who} acknowledged it${step.data.via === "link" ? " from a notification link" : ""}`;
    case "resolved":
      return `${who} resolved it${step.data.resolvedIssue ? " and the issue" : ""}`;
  }
}

function Actions({ detail }: { detail: IncidentDetail }) {
  const { incident } = detail;
  const { acknowledge, resolve } = useIncidentActions(incident.id);
  const [resolveIssue, setResolveIssue] = useState(false);
  const error = acknowledge.error ?? resolve.error;

  if (incident.status === "resolved") return null;
  return (
    <section className="panel">
      <h2>Respond</h2>
      <div className="form-row">
        {incident.status === "triggered" && (
          <button
            type="button"
            className="button button-primary"
            disabled={acknowledge.isPending}
            onClick={() => acknowledge.mutate()}
          >
            Acknowledge
          </button>
        )}
        <button
          type="button"
          className="button"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate(resolveIssue)}
        >
          Resolve
        </button>
        {incident.issue.status !== "resolved" && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={resolveIssue}
              onChange={(e) => setResolveIssue(e.target.checked)}
            />
            Also resolve the issue
          </label>
        )}
      </div>
      {incident.status === "triggered" && (
        <p className="muted">
          Acknowledging tells everyone you're on it, and stops more notifications.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error instanceof ApiError ? error.message : "Something went wrong"}
        </p>
      )}
    </section>
  );
}

export function IncidentPage() {
  const { projectId = "", incidentId = "" } = useParams();
  const detail = useIncident(incidentId);

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorState error={detail.error} retry={() => detail.refetch()} />;
  if (!detail.data) return null;
  const { incident, timeline, deliveries } = detail.data;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="muted">
            <Link to={`/projects/${projectId}/incidents`}>Incidents</Link>
          </p>
          <h1>{incident.title}</h1>
          <div className="issue-meta">
            <IncidentStatusBadge status={incident.status} />
            <SeverityBadge severity={incident.severity} />
            <span title={fullDate(incident.triggeredAt)}>
              triggered {timeAgo(incident.triggeredAt)}
            </span>
          </div>
        </div>
      </header>

      <Actions detail={detail.data} />

      <div className="two-columns">
        <section className="panel">
          <h2>Details</h2>
          <KeyValue
            rows={[
              ["Project", incident.project.name],
              ["Alert rule", incident.rule?.name ?? "deleted rule"],
              ["First responder", incident.responder?.name ?? "Nobody on call"],
              [
                "Escalation",
                incident.escalationPolicy && (
                  <Link
                    key="policy"
                    to={`/projects/${projectId}/escalation/${incident.escalationPolicy.id}`}
                  >
                    {incident.escalationPolicy.name}
                  </Link>
                ),
              ],
              [
                "Next escalation",
                incident.status === "triggered" &&
                  incident.nextEscalationAt &&
                  `${timeAgo(incident.nextEscalationAt)} (${fullDate(incident.nextEscalationAt)})`,
              ],
              [
                "Acknowledged",
                incident.acknowledgedAt &&
                  `${incident.acknowledgedBy?.name ?? "someone"}, ${fullDate(incident.acknowledgedAt)}`,
              ],
              [
                "Resolved",
                incident.resolvedAt &&
                  `${incident.resolvedBy?.name ?? "someone"}, ${fullDate(incident.resolvedAt)}`,
              ],
            ]}
          />
        </section>
        <section className="panel">
          <h2>Issue</h2>
          <p>
            <Link className="issue-title" to={`/projects/${projectId}/issues/${incident.issue.id}`}>
              {incident.issue.title}
            </Link>
          </p>
          <KeyValue
            rows={[
              ["Status", <StatusBadge key="status" status={incident.issue.status} />],
              ["Where", incident.issue.culprit],
              ["Events", incident.issue.eventCount.toLocaleString()],
              ["Users affected", incident.issue.userCount.toLocaleString()],
              ["Last seen", timeAgo(incident.issue.lastSeen)],
            ]}
          />
        </section>
      </div>

      <section className="panel">
        <h2>Timeline</h2>
        <ol className="activity" aria-label="Timeline">
          {timeline.map((step) => (
            <li key={step.id}>
              <span>{describeStep(step)}</span>
              <span className="muted" title={fullDate(step.createdAt)}>
                {timeAgo(step.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel">
        <h2>Notifications</h2>
        {deliveries.length === 0 ? (
          <p className="muted">No notifications were sent.</p>
        ) : (
          <table className="issue-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>To</th>
                <th>Status</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.channelType}</td>
                  <td>{delivery.recipient}</td>
                  <td>
                    <span className={DELIVERY_CLASS[delivery.status]} title={delivery.error ?? ""}>
                      {delivery.status}
                    </span>
                  </td>
                  <td>{delivery.sentAt ? timeAgo(delivery.sentAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
