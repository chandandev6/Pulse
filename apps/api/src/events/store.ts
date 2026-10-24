import { eq, sql } from "drizzle-orm";
import { evaluateAlertRules } from "../alerts/evaluate.js";
import { db, type Tx } from "../db/client.js";
import { isForeignKeyViolation } from "../db/errors.js";
import { environments, events, issueActivity, issues, issueUsers, releases } from "../db/schema.js";
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
      firstRelease: event.release,
      lastRelease: event.release,
    })
    .onConflictDoUpdate({
      target: [issues.projectId, issues.fingerprint],
      // Title, culprit and severity keep their first values; people may edit them later.
      // least/greatest: events can arrive out of order (retries, offline SDKs)
      set: {
        eventCount: sql`${issues.eventCount} + 1`,
        firstSeen: sql`least(${issues.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`greatest(${issues.lastSeen}, excluded.last_seen)`,
        // The release of the oldest event with a release, and of the newest one.
        // (In SET, ${issues.x} is the value *before* this update.)
        firstRelease: sql`case
          when excluded.first_release is not null and excluded.first_seen < ${issues.firstSeen}
          then excluded.first_release
          else coalesce(${issues.firstRelease}, excluded.first_release) end`,
        lastRelease: sql`case
          when excluded.last_release is not null and excluded.last_seen >= ${issues.lastSeen}
          then excluded.last_release
          else coalesce(${issues.lastRelease}, excluded.last_release) end`,
        updatedAt: new Date(),
      },
    })
    // xmax = 0 is a Postgres trick: true when this upsert INSERTED the row (a new issue),
    // false when it UPDATED an existing one
    .returning({ id: issues.id, status: issues.status, isNew: sql<boolean>`(xmax = 0)` });

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

// Releases and environments are created the first time an event mentions them,
// then keep counting. Same upsert idea as issues.
async function trackRelease(tx: Tx, { projectId, event }: EventJob) {
  if (!event.release) return;
  const seenAt = new Date(event.timestamp);
  await tx
    .insert(releases)
    .values({
      projectId,
      version: event.release,
      firstSeen: seenAt,
      lastSeen: seenAt,
      eventCount: 1,
    })
    .onConflictDoUpdate({
      target: [releases.projectId, releases.version],
      set: {
        eventCount: sql`${releases.eventCount} + 1`,
        firstSeen: sql`least(${releases.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`greatest(${releases.lastSeen}, excluded.last_seen)`,
      },
    });
}

async function trackEnvironment(tx: Tx, { projectId, event }: EventJob) {
  const seenAt = new Date(event.timestamp);
  await tx
    .insert(environments)
    .values({
      projectId,
      name: event.environment,
      firstSeen: seenAt,
      lastSeen: seenAt,
      eventCount: 1,
    })
    .onConflictDoUpdate({
      target: [environments.projectId, environments.name],
      set: {
        eventCount: sql`${environments.eventCount} + 1`,
        firstSeen: sql`least(${environments.firstSeen}, excluded.first_seen)`,
        lastSeen: sql`greatest(${environments.lastSeen}, excluded.last_seen)`,
      },
    });
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
      const regressed = issue.status === "resolved";
      if (regressed) await reopenAsRegression(tx, issue.id, event.event_id);

      const key = userKey(event);
      if (key) await countUser(tx, issue.id, key);

      await tx.update(events).set({ issueId: issue.id }).where(eq(events.id, row.id));

      // F10: does this event make any alert rule fire?
      const incidents = await evaluateAlertRules(tx, {
        issue: { id: issue.id, projectId, isNew: issue.isNew, regressed },
        environment: event.environment,
        eventId: event.event_id,
        now: Date.now(),
      });

      // Always in the same order (issue → release → environment) in every transaction,
      // so two workers can never wait on each other in a circle (a deadlock).
      // Last on purpose (F15 load test): every event of a project updates these same
      // few rows, and a row stays locked until COMMIT. Done last, each worker holds
      // the lock for a moment instead of the whole transaction, so workers don't queue.
      await trackRelease(tx, job);
      await trackEnvironment(tx, job);

      return { id: row.id, issueId: issue.id, incidentIds: incidents.map((i) => i.id) };
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) return null; // project is gone, retrying won't help
    throw err;
  }
}
