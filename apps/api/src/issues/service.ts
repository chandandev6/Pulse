import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { issueActivity, issues, memberships } from "../db/schema.js";
import { AppError } from "../errors.js";
import type { Issue } from "../orgs/access.js";
import type { IssueChanges } from "./schemas.js";

type Activity = { action: string; data: { from: unknown; to: unknown } };

// What actually changes for one issue, plus one history entry per change.
// Sending the value it already has changes nothing and logs nothing.
function diff(issue: Issue, changes: IssueChanges) {
  const set: Partial<Issue> = {};
  const activity: Activity[] = [];

  if (changes.status !== undefined && changes.status !== issue.status) {
    set.status = changes.status;
    set.resolvedAt = changes.status === "resolved" ? new Date() : null;
    // A fresh "resolved" clears the regression flag; it's set again if the error comes back
    if (changes.status === "resolved") set.isRegression = false;
    activity.push({ action: "status_changed", data: { from: issue.status, to: changes.status } });
  }

  // A severity set by a person is never overwritten by new events (the worker doesn't touch it)
  if (changes.severity !== undefined && changes.severity !== issue.severity) {
    set.severity = changes.severity;
    activity.push({
      action: "severity_changed",
      data: { from: issue.severity, to: changes.severity },
    });
  }

  if (changes.assigneeId !== undefined && changes.assigneeId !== issue.assigneeId) {
    set.assigneeId = changes.assigneeId;
    activity.push({
      action: changes.assigneeId ? "assigned" : "unassigned",
      data: { from: issue.assigneeId, to: changes.assigneeId },
    });
  }

  return { set, activity };
}

// You can only assign issues to people in the issue's org
export async function assertAssignable(
  tx: Tx,
  orgId: string,
  assigneeId: string | null | undefined,
) {
  if (!assigneeId) return;
  const [member] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, assigneeId)));
  if (!member) {
    throw new AppError(
      400,
      "INVALID_ASSIGNEE",
      "The assignee must be a member of this organization",
    );
  }
}

// Updates one or many issues and records who changed what.
// FOR UPDATE locks the rows (in id order, so two bulk updates can't deadlock),
// so a worker reopening the same issue as a regression waits for us, and vice versa.
export async function updateIssues(
  tx: Tx,
  issueIds: string[],
  changes: IssueChanges,
  actorId: string,
): Promise<Issue[]> {
  if (issueIds.length === 0) return [];

  const current = await tx
    .select()
    .from(issues)
    .where(inArray(issues.id, issueIds))
    .orderBy(issues.id)
    .for("update");

  const result: Issue[] = [];
  for (const issue of current) {
    const { set, activity } = diff(issue, changes);
    if (activity.length === 0) {
      result.push(issue);
      continue;
    }

    const [updated] = await tx
      .update(issues)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(issues.id, issue.id))
      .returning();
    await tx
      .insert(issueActivity)
      .values(activity.map((entry) => ({ issueId: issue.id, actorId, ...entry })));
    result.push(updated ?? issue);
  }
  return result;
}
