import { and, count, countDistinct, desc, eq, exists, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/require-auth.js";
import { db } from "../db/client.js";
import { environments, events, issues, releases } from "../db/schema.js";
import { AppError } from "../errors.js";
import { eventUserKey } from "../events/user-key-sql.js";
import { requireProjectRole } from "../orgs/access.js";
import { parse } from "../validate.js";

type ProjectParams = { projectId: string };
type ReleaseParams = { projectId: string; version: string };

const name = z.string().trim().min(1).max(200);
const EnvironmentQuerySchema = z.object({ environment: name.optional() });
const CompareQuerySchema = z.object({ a: name, b: name, environment: name.optional() });

const LIST_LIMIT = 100;

// Per-issue event counts inside one or two releases, optionally in one environment
function issueCountsIn(projectId: string, versions: string[], environment?: string) {
  const [a, b = a] = versions;
  return db
    .select({
      issueId: events.issueId,
      countA: sql`count(*) filter (where ${events.release} = ${a})`.mapWith(Number),
      countB: sql`count(*) filter (where ${events.release} = ${b})`.mapWith(Number),
    })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        inArray(events.release, versions),
        environment ? eq(events.environment, environment) : undefined,
      ),
    )
    .groupBy(events.issueId)
    .orderBy(desc(count()))
    .limit(300);
}

async function issuesById(ids: string[]) {
  if (ids.length === 0) return new Map<string, typeof issues.$inferSelect>();
  const rows = await db.select().from(issues).where(inArray(issues.id, ids));
  return new Map(rows.map((issue) => [issue.id, issue]));
}

export async function releaseRoutes(app: FastifyInstance) {
  // Environments the project has sent events from, busiest first (for the selector)
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/environments",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const rows = await db
        .select({
          name: environments.name,
          firstSeen: environments.firstSeen,
          lastSeen: environments.lastSeen,
          eventCount: environments.eventCount,
        })
        .from(environments)
        .where(eq(environments.projectId, request.project.id))
        .orderBy(desc(environments.eventCount));

      return { environments: rows };
    },
  );

  // Newest releases first, with how many issues each one introduced
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/releases",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const projectId = request.project.id;
      const newIssues = db
        .select({ version: issues.firstRelease, count: count().as("new_issues") })
        .from(issues)
        .where(eq(issues.projectId, projectId))
        .groupBy(issues.firstRelease)
        .as("new_issues");

      const rows = await db
        .select({
          version: releases.version,
          firstSeen: releases.firstSeen,
          lastSeen: releases.lastSeen,
          eventCount: releases.eventCount,
          newIssues: sql`coalesce(${newIssues.count}, 0)`.mapWith(Number),
        })
        .from(releases)
        .leftJoin(newIssues, eq(newIssues.version, releases.version))
        .where(eq(releases.projectId, projectId))
        .orderBy(desc(releases.lastSeen))
        .limit(LIST_LIMIT);

      return { releases: rows };
    },
  );

  // Compare two releases: what's new in B, what's gone since A, what's in both.
  // Registered before /releases/:version so "compare" isn't read as a version.
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/releases/compare",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const { a, b, environment } = parse(CompareQuerySchema, request.query);
      if (a === b) throw new AppError(400, "SAME_RELEASE", "Pick two different releases");

      const counts = await issueCountsIn(request.project.id, [a, b], environment);
      const byId = await issuesById(counts.flatMap((row) => (row.issueId ? [row.issueId] : [])));

      const rows = counts.flatMap(({ issueId, countA, countB }) => {
        const issue = issueId ? byId.get(issueId) : undefined;
        return issue ? [{ issue, countA, countB }] : [];
      });

      return {
        a,
        b,
        onlyInA: rows.filter((row) => row.countB === 0), // gone in B (fixed?)
        onlyInB: rows.filter((row) => row.countA === 0), // new in B
        inBoth: rows.filter((row) => row.countA > 0 && row.countB > 0),
      };
    },
  );

  // One release: its numbers, the issues it introduced, and every issue seen in it
  app.get<{ Params: ReleaseParams }>(
    "/projects/:projectId/releases/:version",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const projectId = request.project.id;
      const version = parse(name, request.params.version);
      const { environment } = parse(EnvironmentQuerySchema, request.query);

      const [release] = await db
        .select()
        .from(releases)
        .where(and(eq(releases.projectId, projectId), eq(releases.version, version)));
      if (!release) throw new AppError(404, "RELEASE_NOT_FOUND", "Release not found");

      // Everything below respects ?environment=, so the numbers agree with each other
      const inRelease = and(
        eq(events.projectId, projectId),
        eq(events.release, version),
        environment ? eq(events.environment, environment) : undefined,
      );

      const [newIssues, counts, [totals]] = await Promise.all([
        db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.projectId, projectId),
              eq(issues.firstRelease, version),
              // Introduced in this release AND seen in this environment
              environment
                ? exists(
                    db
                      .select({ one: sql`1` })
                      .from(events)
                      .where(
                        and(eq(events.issueId, issues.id), eq(events.environment, environment)),
                      ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(issues.eventCount))
          .limit(LIST_LIMIT),
        issueCountsIn(projectId, [version], environment),
        db
          .select({ events: count(), users: countDistinct(eventUserKey) })
          .from(events)
          .where(inRelease),
      ]);

      const byId = await issuesById(counts.flatMap((row) => (row.issueId ? [row.issueId] : [])));
      const seenIssues = counts.flatMap(({ issueId, countA }) => {
        const issue = issueId ? byId.get(issueId) : undefined;
        return issue ? [{ issue, events: countA }] : [];
      });

      return {
        release: {
          ...release,
          eventCount: totals?.events ?? 0,
          affectedUsers: totals?.users ?? 0,
        },
        newIssues,
        issues: seenIssues,
      };
    },
  );
}
