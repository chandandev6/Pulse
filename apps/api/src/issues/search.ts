import { and, desc, eq, exists, gte, ilike, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db/client.js";
import { events, issueSearchDocument, issues } from "../db/schema.js";
import { afterCursor, decodeCursor, encodeCursor, pageOf } from "../pagination.js";
import type {
  IssueFilters,
  IssueSort,
  ListEventsQuerySchema,
  ListIssuesQuerySchema,
} from "./schemas.js";

const SORTS = {
  last_seen: { column: issues.lastSeen, key: "lastSeen", isDate: true },
  first_seen: { column: issues.firstSeen, key: "firstSeen", isDate: true },
  event_count: { column: issues.eventCount, key: "eventCount", isDate: false },
  user_count: { column: issues.userCount, key: "userCount", isDate: false },
} as const satisfies Record<IssueSort, unknown>;

// In LIKE patterns % and _ are wildcards; a search for "100%" means the text "100%"
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

// "Has at least one event where ...". EXISTS stops at the first match,
// and the (issue_id, environment) / (issue_id, release) indexes make that lookup quick.
const hasEvent = (condition: SQL | undefined) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(events)
      .where(and(eq(events.issueId, issues.id), condition)),
  );

// Every filter is optional; and() skips the undefined ones
function issueConditions(filters: IssueFilters) {
  const { q } = filters;
  return [
    // Whole words (with stemming) OR any part of the title. websearch_to_tsquery
    // understands what people type ("cannot read", -timeout) and never throws on odd input.
    q
      ? or(
          sql`${issueSearchDocument(issues.title, issues.culprit)} @@ websearch_to_tsquery('english', ${q})`,
          ilike(issues.title, `%${escapeLike(q)}%`),
        )
      : undefined,
    filters.status ? inArray(issues.status, filters.status) : undefined,
    filters.severity ? inArray(issues.severity, filters.severity) : undefined,
    filters.environment ? hasEvent(inArray(events.environment, filters.environment)) : undefined,
    filters.release ? hasEvent(inArray(events.release, filters.release)) : undefined,
    // "Active during the range": seen at some point between since and until
    filters.since ? gte(issues.lastSeen, filters.since) : undefined,
    filters.until ? lte(issues.firstSeen, filters.until) : undefined,
  ];
}

type ListQuery = z.infer<typeof ListIssuesQuerySchema>;

// One page of issues inside `scope` (a project, or some projects of an org)
export async function listIssues(scope: SQL | undefined, query: ListQuery, filters: IssueFilters) {
  const sort = SORTS[query.sort];
  const cursor = query.cursor ? decodeCursor(query.cursor, query.sort) : undefined;

  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        scope,
        ...issueConditions(filters),
        cursor ? afterCursor(sort.column, issues.id, cursor, sort.isDate) : undefined,
      ),
    )
    .orderBy(desc(sort.column), desc(issues.id))
    .limit(query.limit + 1);

  const page = pageOf(rows, query.limit, (last) =>
    encodeCursor(query.sort, last[sort.key], last.id),
  );
  return { issues: page.items, nextCursor: page.nextCursor };
}

type EventFilters = z.infer<typeof ListEventsQuerySchema>;

// Narrowing down one issue's events: "only this user", "only release 1.2", "only Chrome"
export function eventConditions(filters: EventFilters) {
  const { user } = filters;
  return [
    user
      ? or(
          sql`${events.user}->>'id' = ${user}`,
          sql`${events.user}->>'email' = ${user}`,
          sql`${events.user}->>'username' = ${user}`,
          sql`${events.user}->>'ip' = ${user}`,
        )
      : undefined,
    filters.environment ? eq(events.environment, filters.environment) : undefined,
    filters.release ? eq(events.release, filters.release) : undefined,
    // @> means "contains": the event's tags include this key with this value
    ...(filters.tag ?? []).map(
      (tag) => sql`${events.tags} @> ${JSON.stringify({ [tag.key]: tag.value })}::jsonb`,
    ),
  ];
}
