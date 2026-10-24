// The shapes the API returns (dates arrive as ISO strings in JSON)

export type Role = "owner" | "admin" | "member";
export type IssueStatus = "unresolved" | "resolved" | "ignored";
export type Severity = "low" | "medium" | "high" | "critical";
export type IssueSort = "last_seen" | "first_seen" | "event_count" | "user_count";

export type User = { id: string; email: string; name: string; createdAt: string };

export type Organization = { id: string; name: string; slug: string; role: Role };

export type Project = {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  platform: string;
  onCallScheduleId: string | null; // F13: who is on call here responds first
  // F15: ingestion limits, retention and scrubbing
  rateLimitPerMinute: number;
  monthlyQuota: number | null; // null = no quota
  retentionDays: number;
  scrubData: boolean;
  scrubFields: string[];
  scrubIpAddresses: boolean;
  createdAt: string;
};

export type ProjectSettings = Pick<
  Project,
  | "rateLimitPerMinute"
  | "monthlyQuota"
  | "retentionDays"
  | "scrubData"
  | "scrubFields"
  | "scrubIpAddresses"
>;

export type ProjectKey = {
  id: string;
  publicKey: string;
  dsn: string;
  createdAt: string;
  revokedAt: string | null;
};

export type Issue = {
  id: string;
  projectId: string;
  title: string;
  type: string | null;
  culprit: string | null;
  status: IssueStatus;
  severity: Severity;
  isRegression: boolean;
  assigneeId: string | null;
  firstRelease: string | null;
  lastRelease: string | null;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  userCount: number;
  resolvedAt: string | null;
};

export type StackFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
};

export type EventUser = { id?: string; email?: string; username?: string; ip?: string };

export type EventRequest = {
  method?: string;
  url?: string;
  route?: string;
  headers?: Record<string, string>;
};

export type PulseEvent = {
  id: string;
  issueId: string | null;
  eventId: string;
  timestamp: string;
  level: string;
  type: string | null;
  message: string | null;
  stacktrace: { frames: StackFrame[] } | null;
  environment: string;
  release: string | null;
  user: EventUser | null;
  request: EventRequest | null;
  tags: Record<string, string> | null;
  context: Record<string, unknown> | null;
  sdk: { name: string; version: string } | null;
};

export type Breakdown = { name: string; count: number };
export type ReleaseBreakdown = Breakdown & { firstSeen: string; lastSeen: string };

export type IssueDetail = {
  issue: Issue & { assignee: Pick<User, "id" | "name" | "email"> | null };
  latestEvent: PulseEvent | null;
  environments: Breakdown[];
  releases: ReleaseBreakdown[];
};

export type EventWithNeighbors = {
  event: PulseEvent;
  previousEventId: string | null;
  nextEventId: string | null;
};

export type Activity = {
  id: string;
  action: string;
  data: { from?: unknown; to?: unknown; eventId?: string; ruleName?: string } | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
};

export type Stats = {
  activeIssues: number;
  criticalIssues: number;
  events24h: number;
  users24h: number;
  totalUsers: number; // all time, all environments: the base for "% of users affected"
};

export type TimeseriesPeriod = "24h" | "7d" | "14d" | "30d" | "90d";

// Events per hour or day; hours/days without events come back as 0
export type Timeseries = {
  interval: "hour" | "day";
  buckets: { start: string; count: number }[];
};
