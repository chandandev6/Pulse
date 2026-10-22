import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AlertCondition, MatchMode } from "../alerts/conditions.js";
import {
  CHANNEL_TYPES,
  type ChannelConfig,
  DELIVERY_STATUSES,
  type DeliveryTrigger,
} from "../notifications/channels.js";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

// Ranked from most to least powerful (see ROLE_RANK in orgs/access.ts)
export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];
export const roleEnum = pgEnum("member_role", ROLES);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The many-to-many link between users and organizations, plus the user's role in that org.
// (user_id, org_id) is the primary key, so a user can only join an org once.
export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.orgId] }),
    index("memberships_org_id_idx").on(table.orgId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Slugs only need to be unique inside one org: two orgs can both have a "website" project
  (table) => [unique("projects_org_id_slug_unique").on(table.orgId, table.slug)],
);

// The public key inside a project's DSN. SDKs send it with every event.
// A key is never deleted, only revoked, so we can tell "revoked" apart from "never existed".
export const projectKeys = pgTable(
  "project_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("project_keys_project_id_idx").on(table.projectId)],
);

// One row per error report. Raw details are kept as JSONB: flexible JSON
// that Postgres can still search inside.
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(), // the SDK's id for this report
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(), // when it happened
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(), // when we got it
    level: text("level").notNull(),
    type: text("type"), // exception type, e.g. "TypeError"
    message: text("message"),
    stacktrace: jsonb("stacktrace"),
    environment: text("environment").notNull(),
    release: text("release"),
    user: jsonb("user"),
    request: jsonb("request"),
    tags: jsonb("tags"),
    context: jsonb("context"),
    sdk: jsonb("sdk"),
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The same report sent twice (SDK retry) is stored once
    unique("events_project_id_event_id_unique").on(table.projectId, table.eventId),
    index("events_project_id_timestamp_idx").on(table.projectId, table.timestamp),
    index("events_issue_id_timestamp_idx").on(table.issueId, table.timestamp),
    // "Issues seen in production / in release 1.2" filters, and the env/release breakdowns
    index("events_issue_id_environment_idx").on(table.issueId, table.environment),
    index("events_issue_id_release_idx").on(table.issueId, table.release),
  ],
);

export const ISSUE_STATUSES = ["unresolved", "resolved", "ignored"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const issueStatusEnum = pgEnum("issue_status", ISSUE_STATUSES);

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityEnum = pgEnum("issue_severity", SEVERITIES);

// The text that full-text search looks at. Searches must use this exact expression,
// or Postgres can't use the index built on it.
export const issueSearchDocument = (title: AnyPgColumn, culprit: AnyPgColumn): SQL =>
  sql`to_tsvector('english', ${title} || ' ' || coalesce(${culprit}, ''))`;

// One issue = one problem in the code. Many events (occurrences) point to it.
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(), // events with the same fingerprint share this issue
    title: text("title").notNull(), // "TypeError: x is undefined"
    type: text("type"), // "TypeError"
    culprit: text("culprit"), // where it broke: "checkout (src/cart.js)"
    status: issueStatusEnum("status").notNull().default("unresolved"),
    severity: severityEnum("severity").notNull(),
    isRegression: boolean("is_regression").notNull().default(false), // came back after "resolved"
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    // Which release introduced it, and the newest release it was seen in (F9)
    firstRelease: text("first_release"),
    lastRelease: text("last_release"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    eventCount: integer("event_count").notNull().default(0),
    userCount: integer("user_count").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("issues_project_id_fingerprint_unique").on(table.projectId, table.fingerprint),
    index("issues_project_id_last_seen_idx").on(table.projectId, table.lastSeen),
    // The dashboard's default view: unresolved issues, most recently seen first
    index("issues_project_id_status_last_seen_idx").on(
      table.projectId,
      table.status,
      table.lastSeen,
    ),
    // Full-text search: whole words, "reading" also finds "read"
    index("issues_search_idx").using("gin", issueSearchDocument(table.title, table.culprit)),
    // "New issues in release X" = issues whose first release is X
    index("issues_project_id_first_release_idx").on(table.projectId, table.firstRelease),
    // Trigram fallback: parts of words and code, like "undef" or "cart.tot"
    index("issues_title_trgm_idx").using("gin", table.title.op("gin_trgm_ops")),
  ],
);

// Which users hit an issue, so user_count only grows for users we haven't seen yet
export const issueUsers = pgTable(
  "issue_users",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    userKey: text("user_key").notNull(), // "id:42", "email:ada@x.com" or "ip:1.2.3.4"
  },
  (table) => [primaryKey({ columns: [table.issueId, table.userKey] })],
);

// The history of an issue: regressions, and status/severity/assignee changes
export const issueActivity = pgTable(
  "issue_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }), // null = Pulse itself
    action: text("action").notNull(), // "regression", "status_changed", ...
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("issue_activity_issue_id_idx").on(table.issueId, table.createdAt)],
);

// One row per version of an app that sent events, created automatically by the worker.
// The counters make the releases page fast: no need to scan every event.
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: text("version").notNull(), // "1.4.2", "shop@2.0.0", a git commit...
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    eventCount: integer("event_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("releases_project_id_version_unique").on(table.projectId, table.version),
    index("releases_project_id_last_seen_idx").on(table.projectId, table.lastSeen),
  ],
);

// Where an app runs: "production", "staging"... also created automatically
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    eventCount: integer("event_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("environments_project_id_name_unique").on(table.projectId, table.name)],
);

// "When X happens in this project, open an incident" (F10)
export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    environment: text("environment"), // null = every environment
    match: text("match").$type<MatchMode>().notNull().default("any"),
    conditions: jsonb("conditions").$type<AlertCondition[]>().notNull(),
    // The action: open an incident with this severity...
    severity: severityEnum("severity").notNull(),
    // ...routed by this escalation policy (the policies table arrives in F14)
    escalationPolicyId: uuid("escalation_policy_id"),
    // After an incident closes, wait this long before the same issue can fire again
    cooldownMinutes: integer("cooldown_minutes").notNull().default(30),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("alert_rules_project_id_idx").on(table.projectId)],
);

export const INCIDENT_STATUSES = ["triggered", "acknowledged", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const incidentStatusEnum = pgEnum("incident_status", INCIDENT_STATUSES);

// A problem someone has to act on. F10 creates them; F11–F14 notify, route and escalate them.
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => alertRules.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: incidentStatusEnum("status").notNull().default("triggered"),
    severity: severityEnum("severity").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    // At most ONE open incident per issue + rule. The database enforces it,
    // so two workers firing the same rule at the same moment can't both create one.
    uniqueIndex("incidents_open_per_issue_rule_idx")
      .on(table.issueId, table.ruleId)
      .where(sql`${table.status} <> 'resolved'`),
    index("incidents_project_id_triggered_at_idx").on(table.projectId, table.triggeredAt),
    index("incidents_rule_id_issue_id_idx").on(table.ruleId, table.issueId, table.triggeredAt),
  ],
);

export const channelTypeEnum = pgEnum("notification_channel_type", CHANNEL_TYPES);

// Where notifications go. Exactly one owner: a user (their own email, phone,
// browsers) or an organization (a team inbox, a webhook).
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: channelTypeEnum("type").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<ChannelConfig>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // The preference: only incidents at least this severe come here.
    // Postgres compares enum values in the order they were declared (low < critical).
    minSeverity: severityEnum("min_severity").notNull().default("low"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "notification_channels_one_owner",
      sql`(${table.userId} is null) <> (${table.orgId} is null)`,
    ),
    index("notification_channels_user_id_idx").on(table.userId),
    index("notification_channels_org_id_idx").on(table.orgId),
  ],
);

export const deliveryStatusEnum = pgEnum("notification_status", DELIVERY_STATUSES);

// One row per message sent (or tried) to one channel: the delivery log
export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "cascade" }), // null = test
    channelId: uuid("channel_id").references(() => notificationChannels.id, {
      onDelete: "set null",
    }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    channelType: channelTypeEnum("channel_type").notNull(),
    recipient: text("recipient").notNull(), // for people to read: "ada@x.com", "hooks.example.com"
    trigger: text("trigger").$type<DeliveryTrigger>().notNull(),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    // A retried job can't notify the same channel twice for the same reason
    uniqueIndex("notification_log_once_idx").on(table.incidentId, table.channelId, table.trigger),
    index("notification_log_org_id_created_at_idx").on(table.orgId, table.createdAt),
    index("notification_log_channel_id_idx").on(table.channelId, table.createdAt),
  ],
);
