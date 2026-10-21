import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { isForeignKeyViolation } from "../db/errors.js";
import { events, issueActivity, issues, issueUsers } from "../db/schema.js";
import { computeFingerprint } from "./fingerprint.js";
import { initialSeverity, issueCulprit, issueTitle, userKey } from "./issue-details.js";
import type { EventJob } from "./queue.js";

// Finds the event's issue (or creates it) and counts this event in it.
// One INSERT ... ON CONFLICT DO UPDATE ("upsert") is atomic: even if 10 workers
// save the same new error at once, exactly one issue is created and every event counts.
// The upsert also locks the issue row until our transaction ends, so the
// follow-up updates below can't race with another worker.
async function upsertIssue(tx: Tx, { projectId, event }: EventJob, fingerprint: string) {
  const seenAt = new Date(event.timestamp);

  const [issue] = await tx
    .insert(issues)
    .values({
      projectId,
      fingerprint,
      title: issueTitle(event),
      type: event.exception?.type,
      culprit: issueCulprit(event),
      severity: initialSeverity(event),
      firstSeen: seenAt,
      lastSeen: seenAt,
      eventCount: 1,
    })
    .onConflictDoUpdate({
      target: [issues.projectId, issues.fingerprint],
      // Title, culprit and severity keep their first values; people may edit them later.
      // least/greatest: events can arrive out of order (retries, offline SDKs)
      set: {
        eventCount: sql`${issues.eventCount} + 1`,
        firstSeen: sql`least(${issues.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`greatest(${issues.lastSeen}, excluded.last_seen)`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: issues.id, status: issues.status });

  return issue;
}

// The problem was marked fixed, but here it is again: reopen it and say so
async function reopenAsRegression(tx: Tx, issueId: string, eventId: string) {
  await tx
    .update(issues)
    .set({ status: "unresolved", isRegression: true, resolvedAt: null })
    .where(eq(issues.id, issueId));
  await tx.insert(issueActivity).values({ issueId, action: "regression", data: { eventId } });
}

// Only counts a user the first time they hit this issue
async function countUser(tx: Tx, issueId: string, key: string) {
  const [added] = await tx
    .insert(issueUsers)
    .values({ issueId, userKey: key })
    .onConflictDoNothing()
    .returning({ key: issueUsers.userKey });
  if (added) {
    await tx
      .update(issues)
      .set({ userCount: sql`${issues.userCount} + 1` })
      .where(eq(issues.id, issueId));
  }
}

// Saves one event and groups it into an issue, all or nothing.
// Returns null when there is nothing to save: a duplicate (same event_id already
// stored) or a project deleted in the meantime.
export async function saveEvent(job: EventJob) {
  const { projectId, receivedAt, event } = job;
  const fingerprint = computeFingerprint(event);

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(events)
        .values({
          projectId,
          eventId: event.event_id,
          timestamp: new Date(event.timestamp),
          receivedAt: new Date(receivedAt),
          level: event.level,
          type: event.exception?.type,
          message: event.exception?.value ?? event.message,
          stacktrace: event.exception?.stacktrace,
          environment: event.environment,
          release: event.release,
          user: event.user,
          request: event.request,
          tags: event.tags,
          context: event.context,
          sdk: event.sdk,
          fingerprint,
        })
        // Idempotency: the SDK may retry a report it isn't sure we received.
        // Stop before touching the issue, so a retry isn't counted twice.
        .onConflictDoNothing({ target: [events.projectId, events.eventId] })
        .returning({ id: events.id });
      if (!row) return null;

      const issue = await upsertIssue(tx, job, fingerprint);
      if (issue.status === "resolved") await reopenAsRegression(tx, issue.id, event.event_id);

      const key = userKey(event);
      if (key) await countUser(tx, issue.id, key);

      await tx.update(events).set({ issueId: issue.id }).where(eq(events.id, row.id));

      return { id: row.id, issueId: issue.id };
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) return null; // project is gone, retrying won't help
    throw err;
  }
}
