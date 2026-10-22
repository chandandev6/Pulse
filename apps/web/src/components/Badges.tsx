import { INCIDENT_STATUS_LABEL, type IncidentStatus } from "../api/incidents";
import type { IssueStatus, Severity } from "../api/types";

const STATUS_LABEL: Record<IssueStatus, string> = {
  unresolved: "Unresolved",
  resolved: "Resolved",
  ignored: "Ignored",
};

export function StatusBadge({ status }: { status: IssueStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge severity-${severity}`}>{severity}</span>;
}

export function RegressionBadge() {
  return (
    <span className="badge badge-regression" title="Came back after being resolved">
      Regression
    </span>
  );
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`badge incident-${status}`}>{INCIDENT_STATUS_LABEL[status]}</span>;
}
