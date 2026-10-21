import { count } from "../format";
import { formatPercent, impactOf } from "../impact";

export function HighImpactBadge() {
  return (
    <span className="badge badge-impact" title="Affects at least 10% of your users">
      High impact
    </span>
  );
}

// "37 · 12%" — the share is only shown when the project's total users is known
export function UsersCell({ userCount, totalUsers }: { userCount: number; totalUsers?: number }) {
  const { percent } = impactOf(userCount, totalUsers);
  return (
    <>
      {count(userCount)}
      {percent !== null && (
        <span className="muted" title={`${formatPercent(percent)} of all users`}>
          {" "}
          · {formatPercent(percent)}
        </span>
      )}
    </>
  );
}
