// "How many of my users does this hit?"
// An issue is high impact when it reaches at least 10% of all known users
// (and at least a few people, so 1 user out of 3 doesn't count as a crisis).
export const HIGH_IMPACT_SHARE = 0.1;
export const HIGH_IMPACT_MIN_USERS = 3;

export type Impact = { percent: number | null; high: boolean };

// totalUsers = every distinct user the project has seen (null/0 = unknown)
export function impactOf(userCount: number, totalUsers: number | null | undefined): Impact {
  if (!totalUsers) return { percent: null, high: false };
  const share = Math.min(userCount / totalUsers, 1);
  return {
    percent: share * 100,
    high: share >= HIGH_IMPACT_SHARE && userCount >= HIGH_IMPACT_MIN_USERS,
  };
}

// 0.4 → "<1%", 12.6 → "13%"
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}
