import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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
  ],
);

export const ISSUE_STATUSES = ["unresolved", "resolved", "ignored"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const issueStatusEnum = pgEnum("issue_status", ISSUE_STATUSES);

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityEnum = pgEnum("issue_severity", SEVERITIES);

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
