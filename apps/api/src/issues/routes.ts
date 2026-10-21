import { and, count, desc, eq, inArray, isNotNull, max, min } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/require-auth.js";
import { db } from "../db/client.js";
import { events, issueActivity, issues, users } from "../db/schema.js";
import { requireEventRole, requireIssueRole, requireProjectRole } from "../orgs/access.js";
import { afterCursor, decodeCursor, encodeCursor, PageQuerySchema, pageOf } from "../pagination.js";
import { parse } from "../validate.js";
import {
  BulkUpdateIssuesSchema,
  type IssueSort,
  ListIssuesQuerySchema,
  UpdateIssueSchema,
} from "./schemas.js";
import { assertAssignable, updateIssues } from "./service.js";

type ProjectParams = { projectId: string };
type IssueParams = { issueId: string };
type EventParams = { eventId: string };

const SORTS = {
  last_seen: { column: issues.lastSeen, key: "lastSeen", isDate: true },
  first_seen: { column: issues.firstSeen, key: "firstSeen", isDate: true },
  event_count: { column: issues.eventCount, key: "eventCount", isDate: false },
  user_count: { column: issues.userCount, key: "userCount", isDate: false },
} as const satisfies Record<IssueSort, unknown>;

// Short version of an event for lists; GET /events/:id has everything
const eventSummary = {
  id: events.id,
  eventId: events.eventId,
  timestamp: events.timestamp,
  level: events.level,
  type: events.type,
  message: events.message,
  environment: events.environment,
  release: events.release,
  user: events.user,
};

const EVENT_SORT = "timestamp";

// Members can read and triage issues (resolve, assign, change severity).
// Changing project settings stays admin-only.
export async function issueRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/issues",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const query = parse(ListIssuesQuerySchema, request.query);
      const sort = SORTS[query.sort];
      const cursor = query.cursor ? decodeCursor(query.cursor, query.sort) : undefined;

      const rows = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.projectId, request.project.id),
            query.status ? eq(issues.status, query.status) : undefined,
            cursor ? afterCursor(sort.column, issues.id, cursor, sort.isDate) : undefined,
          ),
        )
        .orderBy(desc(sort.column), desc(issues.id))
        .limit(query.limit + 1);

      const page = pageOf(rows, query.limit, (last) =>
        encodeCursor(query.sort, last[sort.key], last.id),
      );
      return { issues: page.items, nextCursor: page.nextCursor };
    },
  );

  // Bulk triage: e.g. resolve 20 issues at once. Ids from other projects are ignored.
  app.patch<{ Params: ProjectParams }>(
    "/projects/:projectId/issues",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const { ids, ...changes } = parse(BulkUpdateIssuesSchema, request.body);

      const updated = await db.transaction(async (tx) => {
        await assertAssignable(tx, request.membership.orgId, changes.assigneeId);
        const inProject = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.projectId, request.project.id), inArray(issues.id, ids)));
        return updateIssues(
          tx,
          inProject.map((row) => row.id),
          changes,
          request.user.id,
        );
      });

      return { issues: updated };
    },
  );

  // Everything about one issue: the issue, who it's assigned to, the latest
  // event (with its stack), and where it happens (environments, releases)
  app.get<{ Params: IssueParams }>(
    "/issues/:issueId",
    { preHandler: [requireAuth, requireIssueRole("member")] },
    async (request) => {
      const { issue } = request;
      const ofThisIssue = eq(events.issueId, issue.id);

      const [assignee, latestEvent, environments, releases] = await Promise.all([
        issue.assigneeId
          ? db
              .select({ id: users.id, name: users.name, email: users.email })
              .from(users)
              .where(eq(users.id, issue.assigneeId))
              .then(([user]) => user ?? null)
          : null,
        db
          .select()
          .from(events)
          .where(ofThisIssue)
          .orderBy(desc(events.timestamp), desc(events.id))
          .limit(1)
          .then(([event]) => event ?? null),
        db
          .select({ name: events.environment, count: count() })
          .from(events)
          .where(ofThisIssue)
          .groupBy(events.environment)
          .orderBy(desc(count()))
          .limit(20),
        db
          .select({
            name: events.release,
            count: count(),
            firstSeen: min(events.timestamp),
            lastSeen: max(events.timestamp),
          })
          .from(events)
          .where(and(ofThisIssue, isNotNull(events.release)))
          .groupBy(events.release)
          .orderBy(desc(max(events.timestamp)))
          .limit(20),
      ]);

      return { issue: { ...issue, assignee }, latestEvent, environments, releases };
    },
  );

  app.patch<{ Params: IssueParams }>(
    "/issues/:issueId",
    { preHandler: [requireAuth, requireIssueRole("member")] },
    async (request) => {
      const changes = parse(UpdateIssueSchema, request.body);

      const [issue] = await db.transaction(async (tx) => {
        await assertAssignable(tx, request.membership.orgId, changes.assigneeId);
        return updateIssues(tx, [request.issue.id], changes, request.user.id);
      });

      return { issue };
    },
  );

  app.get<{ Params: IssueParams }>(
    "/issues/:issueId/events",
    { preHandler: [requireAuth, requireIssueRole("member")] },
    async (request) => {
      const query = parse(PageQuerySchema, request.query);
      const cursor = query.cursor ? decodeCursor(query.cursor, EVENT_SORT) : undefined;

      const rows = await db
        .select(eventSummary)
        .from(events)
        .where(
          and(
            eq(events.issueId, request.issue.id),
            cursor ? afterCursor(events.timestamp, events.id, cursor, true) : undefined,
          ),
        )
        .orderBy(desc(events.timestamp), desc(events.id))
        .limit(query.limit + 1);

      const page = pageOf(rows, query.limit, (last) =>
        encodeCursor(EVENT_SORT, last.timestamp, last.id),
      );
      return { events: page.items, nextCursor: page.nextCursor };
    },
  );

  // Newest first, with who did it (null actor = Pulse itself, e.g. a regression)
  app.get<{ Params: IssueParams }>(
    "/issues/:issueId/activity",
    { preHandler: [requireAuth, requireIssueRole("member")] },
    async (request) => {
      const activity = await db
        .select({
          id: issueActivity.id,
          action: issueActivity.action,
          data: issueActivity.data,
          createdAt: issueActivity.createdAt,
          actor: { id: users.id, name: users.name },
        })
        .from(issueActivity)
        .leftJoin(users, eq(users.id, issueActivity.actorId))
        .where(eq(issueActivity.issueId, request.issue.id))
        .orderBy(desc(issueActivity.createdAt))
        .limit(100);

      return { activity };
    },
  );

  app.get<{ Params: EventParams }>(
    "/events/:eventId",
    { preHandler: [requireAuth, requireEventRole("member")] },
    async (request) => ({ event: request.event }),
  );
}
