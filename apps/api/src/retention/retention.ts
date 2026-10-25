import { Queue, Worker } from "bullmq";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { events, projects, sourceMaps } from "../db/schema.js";
import { queueConnection } from "../events/queue.js";

export const MAINTENANCE_QUEUE = "maintenance";

// Deleting a million rows in one statement would lock the table and bloat the
// transaction log. Small batches let the worker (and everyone else) keep going.
const BATCH_SIZE = 5_000;

export type RetentionResult = { projects: number; deleted: number };

// Deletes one project's events older than its retention period, batch by batch.
// Uses the (project_id, timestamp) index. Issues keep their counts and history:
// only the raw occurrences go.
async function deleteOldEvents(projectId: string, cutoff: Date): Promise<number> {
  let total = 0;
  while (true) {
    const batch = db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.projectId, projectId), lt(events.timestamp, cutoff)))
      .limit(BATCH_SIZE);
    const deleted = await db
      .delete(events)
      .where(sql`${events.id} in (${batch})`)
      .returning({ id: events.id });
    total += deleted.length;
    if (deleted.length < BATCH_SIZE) return total;
  }
}

export async function runRetention(now = new Date()): Promise<RetentionResult> {
  const rows = await db
    .select({ id: projects.id, retentionDays: projects.retentionDays })
    .from(projects);

  let deleted = 0;
  for (const project of rows) {
    const cutoff = new Date(now.getTime() - project.retentionDays * 86_400_000);
    deleted += await deleteOldEvents(project.id, cutoff);
    // Source maps of releases older than that only served events that are gone now
    await db
      .delete(sourceMaps)
      .where(and(eq(sourceMaps.projectId, project.id), lt(sourceMaps.createdAt, cutoff)));
  }
  return { projects: rows.length, deleted };
}

type MaintenanceJob = { kind: "retention" };

export const maintenanceQueue = new Queue<MaintenanceJob>(MAINTENANCE_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
});

// A job scheduler: BullMQ creates the job every day at 03:00 UTC. Calling this again
// (every worker start) updates the same scheduler instead of adding a second one.
export async function scheduleRetention() {
  await maintenanceQueue.upsertJobScheduler(
    "retention-daily",
    { pattern: "0 3 * * *", tz: "UTC" },
    { name: "retention", data: { kind: "retention" } },
  );
}

export function createMaintenanceWorker() {
  return new Worker<MaintenanceJob, RetentionResult>(MAINTENANCE_QUEUE, () => runRetention(), {
    connection: queueConnection,
    concurrency: 1, // never two cleanups at once
  });
}
