import { and, eq, ne } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { incidents, incidentTimeline, issueActivity, issues, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { updateIssues } from "../issues/service.js";
import { cancelEscalationJob } from "../notifications/queue.js";
import type { TimelineData, TimelineKind } from "./timeline.js";

export type Incident = typeof incidents.$inferSelect;

// One step in the incident's history. Doing the same step twice (a retried job)
// changes nothing: the partial unique index turns the second insert into a no-op.
export async function addTimeline<K extends TimelineKind>(
  tx: Tx | typeof db,
  incidentId: string,
  kind: K,
  data: TimelineData[K],
  actorId: string | null = null,
  at?: Date, // default: now, by the database clock
) {
  await tx
    .insert(incidentTimeline)
    .values({ incidentId, kind, data, actorId, createdAt: at })
    .onConflictDoNothing();
}

const incidentNotFound = () => new AppError(404, "INCIDENT_NOT_FOUND", "Incident not found");

// Locks the incident's issue first, then reads the incident.
// The event worker also locks the issue before it touches incidents, so taking
// the locks in the same order (issue → incident) means we can never deadlock with it.
async function lockIncident(tx: Tx, incidentId: string) {
  const [found] = await tx
    .select({ issueId: incidents.issueId })
    .from(incidents)
    .where(eq(incidents.id, incidentId));
  if (!found) throw incidentNotFound();
  await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, found.issueId)).for("update");
}

// After the change is committed: remove the delayed "escalate" job (F14).
// If that fails (Redis down) nothing breaks: the job runs, sees the status and stops.
async function cancelPendingEscalation(incident: Incident) {
  if (!incident.escalationPolicyId) return;
  try {
    await cancelEscalationJob(incident.id, incident.escalationStep + 1);
  } catch {
    // harmless, see above
  }
}

export type AckResult =
  | { ok: true; incident: Incident }
  | {
      ok: false;
      // Someone was faster: say who, so nobody else starts working on it too
      acknowledgedBy: { id: string; name: string } | null;
      acknowledgedAt: Date | null;
    };

// "I'm on it." Only a triggered incident can be acknowledged, and only once.
export async function acknowledgeIncident(
  incidentId: string,
  userId: string,
  via: TimelineData["acknowledged"]["via"],
): Promise<AckResult> {
  const result = await acknowledge(incidentId, userId, via);
  if (result.ok) await cancelPendingEscalation(result.incident);
  return result;
}

async function acknowledge(
  incidentId: string,
  userId: string,
  via: TimelineData["acknowledged"]["via"],
): Promise<AckResult> {
  return db.transaction(async (tx) => {
    await lockIncident(tx, incidentId);

    // The WHERE status = 'triggered' is the guard: if two people click at the same
    // moment, the second UPDATE finds the status already changed and updates nothing
    const [incident] = await tx
      .update(incidents)
      .set({
        status: "acknowledged",
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
        nextEscalationAt: null, // someone has it: stop escalating (F14)
      })
      .where(and(eq(incidents.id, incidentId), eq(incidents.status, "triggered")))
      .returning();

    if (incident) {
      await addTimeline(tx, incidentId, "acknowledged", { via }, userId);
      await tx.insert(issueActivity).values({
        issueId: incident.issueId,
        actorId: userId,
        action: "incident_acknowledged",
        data: { incidentId },
      });
      return { ok: true, incident };
    }

    const [current] = await tx
      .select({
        incident: incidents,
        acknowledgedBy: { id: users.id, name: users.name },
      })
      .from(incidents)
      .leftJoin(users, eq(users.id, incidents.acknowledgedBy))
      .where(eq(incidents.id, incidentId));
    if (!current) throw incidentNotFound();

    if (current.incident.status === "resolved") {
      throw new AppError(409, "INCIDENT_RESOLVED", "This incident is already resolved");
    }
    // Clicking twice (or the email link after the dashboard button) is fine
    if (current.incident.acknowledgedBy === userId) return { ok: true, incident: current.incident };

    return {
      ok: false,
      acknowledgedBy: current.acknowledgedBy,
      acknowledgedAt: current.incident.acknowledgedAt,
    };
  });
}

// "It's fixed." Works from triggered or acknowledged; resolved is final.
// resolveIssue: also mark the issue resolved (it reopens as a regression if the error returns).
export async function resolveIncident(
  incidentId: string,
  userId: string,
  { resolveIssue }: { resolveIssue: boolean },
) {
  const incident = await resolve(incidentId, userId, { resolveIssue });
  await cancelPendingEscalation(incident);
  return incident;
}

async function resolve(
  incidentId: string,
  userId: string,
  { resolveIssue }: { resolveIssue: boolean },
) {
  return db.transaction(async (tx) => {
    await lockIncident(tx, incidentId);

    const [incident] = await tx
      .update(incidents)
      .set({
        status: "resolved",
        resolvedBy: userId,
        resolvedAt: new Date(),
        nextEscalationAt: null,
      })
      .where(and(eq(incidents.id, incidentId), ne(incidents.status, "resolved")))
      .returning();
    if (!incident) {
      throw new AppError(409, "INCIDENT_RESOLVED", "This incident is already resolved");
    }

    await addTimeline(tx, incidentId, "resolved", { resolvedIssue: resolveIssue }, userId);
    await tx.insert(issueActivity).values({
      issueId: incident.issueId,
      actorId: userId,
      action: "incident_resolved",
      data: { incidentId },
    });
    if (resolveIssue) await updateIssues(tx, [incident.issueId], { status: "resolved" }, userId);

    return incident;
  });
}
