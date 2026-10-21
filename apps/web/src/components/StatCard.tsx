import { count } from "../format";

export function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <div className={`stat-card ${tone && value > 0 ? `stat-${tone}` : ""}`}>
      <div className="stat-value">{count(value)}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
