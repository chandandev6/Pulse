import { db } from "../db/client.js";
import { isForeignKeyViolation } from "../db/errors.js";
import { events } from "../db/schema.js";
import type { EventJob } from "./queue.js";

// Saves one event. Returns null when there is nothing to save:
// a duplicate (same event_id already stored) or a project deleted in the meantime.
export async function saveEvent({ projectId, receivedAt, event }: EventJob) {
  try {
    const [row] = await db
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
      })
      // Idempotency: the SDK may retry a report it isn't sure we received
      .onConflictDoNothing({ target: [events.projectId, events.eventId] })
      .returning({ id: events.id });
    return row ?? null;
  } catch (err) {
    if (isForeignKeyViolation(err)) return null; // project is gone, retrying won't help
    throw err;
  }
}
