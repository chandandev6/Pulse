import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import {
  scheduleLayerParticipants,
  scheduleLayers,
  scheduleOverrides,
  schedules,
  users,
} from "../db/schema.js";
import { getOnCall, type LayerData, type OnCall, type ScheduleData } from "./resolve.js";

export type UserSummary = { id: string; name: string; email: string };

// Loads what the resolver needs for these schedules. Only overrides that touch
// [from, to) are loaded: old ones can't change the answer.
export async function loadScheduleData(scheduleIds: string[], from: Date, to: Date) {
  const result = new Map<string, ScheduleData>();
  if (scheduleIds.length === 0) return result;

  const [scheduleRows, layerRows, participantRows, overrideRows] = await Promise.all([
    db.select().from(schedules).where(inArray(schedules.id, scheduleIds)),
    db
      .select()
      .from(scheduleLayers)
      .where(inArray(scheduleLayers.scheduleId, scheduleIds))
      .orderBy(asc(scheduleLayers.position)),
    db
      .select({
        layerId: scheduleLayerParticipants.layerId,
        userId: scheduleLayerParticipants.userId,
      })
      .from(scheduleLayerParticipants)
      .innerJoin(scheduleLayers, eq(scheduleLayers.id, scheduleLayerParticipants.layerId))
      .where(inArray(scheduleLayers.scheduleId, scheduleIds))
      .orderBy(asc(scheduleLayerParticipants.position)),
    db
      .select()
      .from(scheduleOverrides)
      .where(
        and(
          inArray(scheduleOverrides.scheduleId, scheduleIds),
          lt(scheduleOverrides.startsAt, to),
          gt(scheduleOverrides.endsAt, from),
        ),
      ),
  ]);

  for (const schedule of scheduleRows) {
    const layers: LayerData[] = layerRows
      .filter((layer) => layer.scheduleId === schedule.id)
      .map((layer) => ({
        ...layer,
        participants: participantRows.filter((p) => p.layerId === layer.id).map((p) => p.userId),
      }));
    const overrides = overrideRows.filter((o) => o.scheduleId === schedule.id);
    result.set(schedule.id, { timezone: schedule.timezone, layers, overrides });
  }
  return result;
}

// For other features (F13 incidents, F14 escalation): who is on call for one schedule
// at one moment, straight from the database. null = no such schedule, or nobody in it.
export async function getOnCallForSchedule(scheduleId: string, at = new Date()) {
  const data = await loadScheduleData([scheduleId], at, new Date(at.getTime() + 1));
  const schedule = data.get(scheduleId);
  return schedule ? getOnCall(schedule, at) : null;
}

export async function loadUsers(ids: Iterable<string>) {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, unique))
    : [];
  return new Map<string, UserSummary>(rows.map((user) => [user.id, user]));
}

// The resolver speaks in user ids; the API answers with names
export function describeOnCall(onCall: OnCall | null, people: Map<string, UserSummary>) {
  if (!onCall) return null;
  return {
    user: people.get(onCall.userId) ?? { id: onCall.userId, name: "Unknown", email: "" },
    source: onCall.source,
    layer: onCall.source === "layer" ? { id: onCall.layerId, name: onCall.layerName } : null,
    overrideId: onCall.source === "override" ? onCall.overrideId : null,
  };
}

// Someone left the org: take them out of its rotations (the others close ranks,
// keeping their order) and drop their overrides
export async function removeFromSchedules(tx: Tx, orgId: string, userId: string) {
  const orgSchedules = tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(eq(schedules.orgId, orgId));
  const orgLayers = tx
    .select({ id: scheduleLayers.id })
    .from(scheduleLayers)
    .where(inArray(scheduleLayers.scheduleId, orgSchedules));

  const removed = await tx
    .delete(scheduleLayerParticipants)
    .where(
      and(
        eq(scheduleLayerParticipants.userId, userId),
        inArray(scheduleLayerParticipants.layerId, orgLayers),
      ),
    )
    .returning({ layerId: scheduleLayerParticipants.layerId });

  for (const layerId of new Set(removed.map((row) => row.layerId))) {
    const rest = await tx
      .delete(scheduleLayerParticipants)
      .where(eq(scheduleLayerParticipants.layerId, layerId))
      .returning();
    rest.sort((a, b) => a.position - b.position);
    if (rest.length > 0) {
      await tx
        .insert(scheduleLayerParticipants)
        .values(rest.map((row, position) => ({ layerId, userId: row.userId, position })));
    }
  }

  await tx
    .delete(scheduleOverrides)
    .where(
      and(
        eq(scheduleOverrides.userId, userId),
        inArray(scheduleOverrides.scheduleId, orgSchedules),
      ),
    );
}
