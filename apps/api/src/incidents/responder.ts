import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects } from "../db/schema.js";
import type { OnCall } from "../schedules/resolve.js";
import { getOnCallForSchedule } from "../schedules/service.js";

// "override": someone covering a shift. "layer": the normal rotation.
export type OnCallSource = OnCall["source"];
export type FirstResponder = { userId: string; source: OnCallSource };

// Who should respond first when an incident opens: whoever is on call right now
// on the project's schedule. null = no schedule picked, or nobody in it
// (then every member is notified, as before F13).
export async function getFirstResponder(
  projectId: string,
  at: Date,
): Promise<FirstResponder | null> {
  const [project] = await db
    .select({ scheduleId: projects.onCallScheduleId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project?.scheduleId) return null;

  const onCall = await getOnCallForSchedule(project.scheduleId, at);
  return onCall ? { userId: onCall.userId, source: onCall.source } : null;
}
