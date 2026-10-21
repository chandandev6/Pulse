import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  max,
  min,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/require-auth.js";
import { db } from "../db/client.js";
import { events, issueActivity, issues, projects, users } from "../db/schema.js";
import { eventUserKey } from "../events/user-key-sql.js";
import {
  requireEventRole,
  requireIssueRole,
  requireOrgRole,
  requireProjectRole,
} from "../orgs/access.js";
import { afterCursor, decodeCursor, encodeCursor, pageOf } from "../pagination.js";
import { parse } from "../validate.js";
import {
  BulkUpdateIssuesSchema,
  IssueFiltersSchema,
  ListEventsQuerySchema,
  ListIssuesQuerySchema,
  OrgIssuesQuerySchema,
  StatsQuerySchema,
  TimeseriesQuerySchema,
  UpdateIssueSchema,
} from "./schemas.js";
import { eventConditions, listIssues } from "./search.js";
import { assertAssignable, updateIssues } from "./service.js";
import { eventTimeseries } from "./timeseries.js";

type OrgParams = { orgId: string };
type ProjectParams = { projectId: string };
type IssueParams = { issueId: string };
type EventParams = { eventId: string };

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
const DAY_MS = 24 * 60 * 60 * 1000;

// Members can read and triage issues (resolve, assign, change severity).
// Changing project settings stays admin-only.
export async function issueRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/issues",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const query = parse(ListIssuesQuerySchema, request.query);
      const filters = parse(IssueFiltersSchema, request.query);
      return listIssues(eq(issues.projectId, request.project.id), query, filters);
    },
  );

  // Every project in the org at once, or only some: ?project=<id>,<id>.
  // Ids of projects outside this org are ignored.
  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/issues",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const query = parse(OrgIssuesQuerySchema, request.query);
      const filters = parse(IssueFiltersSchema, request.query);
      const orgProjects = db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, request.membership.orgId),
            query.project ? inArray(projects.id, query.project) : undefined,
          ),
        );
      return listIssues(inArray(issues.projectId, orgProjects), query, filters);
    },
  );

  // Events per hour/day across the whole project, e.g. ?period=7d&environment=production
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/timeseries",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const query = parse(TimeseriesQuerySchema, request.query);
      return eventTimeseries(eq(events.projectId, request.project.id), query);
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
      const query = parse(ListEventsQuerySchema, request.query);
      const cursor = query.cursor ? decodeCursor(query.cursor, EVENT_SORT) : undefined;

      const rows = await db
        .select(eventSummary)
        .from(events)
        .where(
          and(
            eq(events.issueId, request.issue.id),
            ...eventConditions(query),
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

  app.get<{ Params: IssueParams }>(
    "/issues/:issueId/timeseries",
    { preHandler: [requireAuth, requireIssueRole("member")] },
    async (request) => {
      const query = parse(TimeseriesQuerySchema, request.query);
      return eventTimeseries(eq(events.issueId, request.issue.id), query);
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
    async (request) => {
      const { event } = request;
      if (!event.issueId) return { event, previousEventId: null, nextEventId: null };

      // The events just before and after this one in the same issue, for "older / newer" buttons
      const sameIssue = eq(events.issueId, event.issueId);
      const sameTime = eq(events.timestamp, event.timestamp);
      const [previous, next] = await Promise.all([
        db
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              sameIssue,
              or(lt(events.timestamp, event.timestamp), and(sameTime, lt(events.id, event.id))),
            ),
          )
          .orderBy(desc(events.timestamp), desc(events.id))
          .limit(1),
        db
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              sameIssue,
              or(gt(events.timestamp, event.timestamp), and(sameTime, gt(events.id, event.id))),
            ),
          )
          .orderBy(asc(events.timestamp), asc(events.id))
          .limit(1),
      ]);

      return {
        event,
        previousEventId: previous[0]?.id ?? null,
        nextEventId: next[0]?.id ?? null,
      };
    },
  );

  // Numbers for the dashboard's overview cards. ?environment= limits them to one environment.
  // totalUsers (all time, all environments) is the base for "% of users affected",
  // so it's comparable with each issue's userCount.
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/stats",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const projectId = request.project.id;
      const { environment } = parse(StatsQuerySchema, request.query);
      const since = new Date(Date.now() - DAY_MS);
      const inEnvironment = environment ? eq(events.environment, environment) : undefined;

      const [[issueStats], [eventStats], [userStats]] = await Promise.all([
        db
          .select({
            activeIssues: count(),
            criticalIssues: sql`count(*) filter (where ${issues.severity} = 'critical')`.mapWith(
              Number,
            ),
          })
          .from(issues)
          .where(
            and(
              eq(issues.projectId, projectId),
              eq(issues.status, "unresolved"),
              // Only issues that happened in this environment
              environment
                ? exists(
                    db
                      .select({ one: sql`1` })
                      .from(events)
                      .where(and(eq(events.issueId, issues.id), inEnvironment)),
                  )
                : undefined,
            ),
          ),
        db
          .select({
            events24h: count(),
            users24h: sql`count(distinct ${eventUserKey})`.mapWith(Number),
          })
          .from(events)
          .where(and(eq(events.projectId, projectId), gte(events.timestamp, since), inEnvironment)),
        db
          .select({ totalUsers: sql`count(distinct ${eventUserKey})`.mapWith(Number) })
          .from(events)
          .where(eq(events.projectId, projectId)),
      ]);

      return { stats: { ...issueStats, ...eventStats, ...userStats } };
    },
  );
}
