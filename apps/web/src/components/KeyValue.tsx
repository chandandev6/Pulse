import type { ReactNode } from "react";

// A small two-column table; empty values are skipped
export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  const visible = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (visible.length === 0) return <p className="muted">Nothing sent.</p>;
  return (
    <dl className="kv">
      {visible.map(([key, value]) => (
        <div key={key} className="kv-row">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
