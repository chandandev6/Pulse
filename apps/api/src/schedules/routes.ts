import { and, asc, count, eq, gt, inArray, max, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { IANAZone } from "luxon";
import { z } from "zod";
import { requireAuth } from "../auth/require-auth.js";
import { db, type Tx } from "../db/client.js";
import {
  memberships,
  scheduleLayerParticipants,
  scheduleLayers,
  scheduleOverrides,
  schedules,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { forbidden, hasRole, requireOrgRole, requireScheduleRole } from "../orgs/access.js";
import { parse } from "../validate.js";
import { getOnCall, MAX_RANGE_MS, onCallUntil, shiftsBetween } from "./resolve.js";
import { describeOnCall, loadScheduleData, loadUsers } from "./service.js";
import { ROTATION_TYPES } from "./types.js";

type OrgParams = { orgId: string };
type ScheduleParams = { scheduleId: string };
type LayerParams = ScheduleParams & { layerId: string };
type OverrideParams = ScheduleParams & { overrideId: string };

const DAY = 24 * 60 * 60 * 1000;

const Timezone = z
  .string()
  .refine((zone) => IANAZone.isValidZone(zone), "Unknown timezone, use a name like Asia/Kolkata");
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 09:00");

const ScheduleFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable(),
  timezone: Timezone,
};
const CreateScheduleSchema = z.object({
  ...ScheduleFields,
  description: ScheduleFields.description.default(null),
});
const UpdateScheduleSchema = z
  .object(ScheduleFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");

const RestrictionSchema = z.object({
  days: z.array(z.int().min(1).max(7)).min(1).max(7), // 1 = Monday ... 7 = Sunday
  start: Time,
  end: Time,
});

const LayerFields = {
  name: z.string().trim().min(1).max(100),
  rotationType: z.enum(ROTATION_TYPES),
  shiftLengthHours: z
    .int()
    .min(1)
    .max(24 * 28)
    .nullable(),
  handoffTime: Time,
  startDate: z.iso.date(),
  restriction: RestrictionSchema.nullable(),
  participants: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Each person can only be listed once"),
};

const customNeedsLength = (layer: { rotationType?: string; shiftLengthHours?: number | null }) =>
  layer.rotationType !== "custom" || Boolean(layer.shiftLengthHours);
const LENGTH_MESSAGE = { message: "A custom rotation needs shiftLengthHours" };

const CreateLayerSchema = z
  .object({
    ...LayerFields,
    shiftLengthHours: LayerFields.shiftLengthHours.default(null),
    handoffTime: LayerFields.handoffTime.default("09:00"),
    restriction: LayerFields.restriction.default(null),
  })
  .refine(customNeedsLength, LENGTH_MESSAGE);
const UpdateLayerSchema = z
  .object(LayerFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");

const MAX_OVERRIDE_MS = 90 * DAY;
const CreateOverrideSchema = z
  .object({
    userId: z.uuid().optional(), // default: yourself
    startsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    endsAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  })
  .refine((o) => o.endsAt > o.startsAt, "endsAt must be after startsAt")
  .refine(
    (o) => o.endsAt.getTime() - o.startsAt.getTime() <= MAX_OVERRIDE_MS,
    "An override can last at most 90 days",
  );

const AtSchema = z.object({
  at: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
});
const RangeSchema = z
  .object({
    from: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    to: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
  })
  .transform(({ from = new Date(), to }) => ({
    from,
    to: to ?? new Date(from.getTime() + 14 * DAY),
  }))
  .refine(({ from, to }) => to > from, "to must be after from")
  .refine(
    ({ from, to }) => to.getTime() - from.getTime() <= MAX_RANGE_MS,
    "Ask for at most 31 days at a time",
  );

const layerNotFound = () => new AppError(404, "LAYER_NOT_FOUND", "Layer not found");

// Everyone in a rotation must be in the schedule's org
async function assertMembers(orgId: string, userIds: string[]) {
  const [row] = await db
    .select({ count: count() })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), inArray(memberships.userId, userIds)));
  if ((row?.count ?? 0) !== userIds.length) {
    throw new AppError(
      400,
      "NOT_A_MEMBER",
      "Everyone on call must be a member of this organization",
    );
  }
}

// The bottom layer is the safety net: it must cover every minute, so it can't have
// a restriction. That's what makes "exactly one person on call" always true.
const bottomLayerError = () =>
  new AppError(
    400,
    "BOTTOM_LAYER_RESTRICTED",
    "The bottom layer must always be active: remove its restriction (put time-limited layers on top)",
  );

async function replaceParticipants(tx: Tx, layerId: string, userIds: string[]) {
  await tx.delete(scheduleLayerParticipants).where(eq(scheduleLayerParticipants.layerId, layerId));
  await tx
    .insert(scheduleLayerParticipants)
    .values(userIds.map((userId, position) => ({ layerId, userId, position })));
}

// Locks the schedule row, so two people adding layers at once get different positions
async function lockSchedule(tx: Tx, scheduleId: string) {
  await tx.execute(
    sql`select 1 from ${schedules} where ${schedules.id} = ${scheduleId} for update`,
  );
}

// Works inside a transaction or outside one
async function layersOf(conn: Tx | typeof db, scheduleId: string) {
  return conn
    .select()
    .from(scheduleLayers)
    .where(eq(scheduleLayers.scheduleId, scheduleId))
    .orderBy(asc(scheduleLayers.position));
}

// Schedules with who is on call right now (and until when)
async function withOnCallNow(rows: (typeof schedules.$inferSelect)[], now = new Date()) {
  const data = await loadScheduleData(
    rows.map((s) => s.id),
    now,
    new Date(now.getTime() + MAX_RANGE_MS),
  );
  const answers = rows.map((schedule) => {
    const scheduleData = data.get(schedule.id);
    const onCall = scheduleData ? getOnCall(scheduleData, now) : null;
    const until = scheduleData && onCall ? onCallUntil(scheduleData, now) : null;
    return { schedule, onCall, until };
  });
  const people = await loadUsers(answers.flatMap((a) => (a.onCall ? [a.onCall.userId] : [])));
  return answers.map(({ schedule, onCall, until }) => ({
    ...schedule,
    onCall: describeOnCall(onCall, people),
    onCallUntil: until,
  }));
}

export async function scheduleRoutes(app: FastifyInstance) {
  // ---------- Schedules ----------

  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/schedules",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const rows = await db
        .select()
        .from(schedules)
        .where(eq(schedules.orgId, request.membership.orgId))
        .orderBy(asc(schedules.name));
      return { schedules: await withOnCallNow(rows) };
    },
  );

  // The "who's on call now" widget: one line per schedule
  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/oncall",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const rows = await db
        .select()
        .from(schedules)
        .where(eq(schedules.orgId, request.membership.orgId))
        .orderBy(asc(schedules.name));
      const list = await withOnCallNow(rows);
      return {
        oncall: list.map((s) => ({
          schedule: { id: s.id, name: s.name, timezone: s.timezone },
          onCall: s.onCall,
          until: s.onCallUntil,
        })),
      };
    },
  );

  app.post<{ Params: OrgParams }>(
    "/orgs/:orgId/schedules",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request, reply) => {
      const body = parse(CreateScheduleSchema, request.body);
      const [schedule] = await db
        .insert(schedules)
        .values({ ...body, orgId: request.membership.orgId })
        .returning();
      return reply.code(201).send({ schedule });
    },
  );

  // A schedule with its layers (and their people) and the overrides still to come
  app.get<{ Params: ScheduleParams }>(
    "/schedules/:scheduleId",
    { preHandler: [requireAuth, requireScheduleRole("member")] },
    async (request) => {
      const schedule = request.schedule;
      const now = new Date();
      const [layers, participants, overrides, [withNow]] = await Promise.all([
        layersOf(db, schedule.id),
        db
          .select()
          .from(scheduleLayerParticipants)
          .innerJoin(scheduleLayers, eq(scheduleLayers.id, scheduleLayerParticipants.layerId))
          .where(eq(scheduleLayers.scheduleId, schedule.id))
          .orderBy(asc(scheduleLayerParticipants.position)),
        db
          .select()
          .from(scheduleOverrides)
          .where(
            and(eq(scheduleOverrides.scheduleId, schedule.id), gt(scheduleOverrides.endsAt, now)),
          )
          .orderBy(asc(scheduleOverrides.startsAt)),
        withOnCallNow([schedule], now),
      ]);

      const people = await loadUsers([
        ...participants.map((p) => p.schedule_layer_participants.userId),
        ...overrides.map((o) => o.userId),
      ]);
      const person = (id: string) => people.get(id) ?? { id, name: "Unknown", email: "" };

      return {
        schedule: withNow,
        layers: layers.map((layer) => ({
          ...layer,
          participants: participants
            .filter((p) => p.schedule_layer_participants.layerId === layer.id)
            .map((p) => person(p.schedule_layer_participants.userId)),
        })),
        overrides: overrides.map((o) => ({ ...o, user: person(o.userId) })),
      };
    },
  );

  app.patch<{ Params: ScheduleParams }>(
    "/schedules/:scheduleId",
    { preHandler: [requireAuth, requireScheduleRole("admin")] },
    async (request) => {
      const changes = parse(UpdateScheduleSchema, request.body);
      const [schedule] = await db
        .update(schedules)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(schedules.id, request.schedule.id))
        .returning();
      return { schedule };
    },
  );

  app.delete<{ Params: ScheduleParams }>(
    "/schedules/:scheduleId",
    { preHandler: [requireAuth, requireScheduleRole("admin")] },
    async (request, reply) => {
      await db.delete(schedules).where(eq(schedules.id, request.schedule.id));
      return reply.code(204).send();
    },
  );

  // ---------- Who is on call ----------

  // ?at= any moment (default: now). Exactly one person, as long as the schedule has a layer.
  app.get<{ Params: ScheduleParams }>(
    "/schedules/:scheduleId/oncall",
    { preHandler: [requireAuth, requireScheduleRole("member")] },
    async (request) => {
      const { at = new Date() } = parse(AtSchema, request.query);
      const data = await loadScheduleData(
        [request.schedule.id],
        at,
        new Date(at.getTime() + MAX_RANGE_MS),
      );
      const scheduleData = data.get(request.schedule.id);
      const onCall = scheduleData ? getOnCall(scheduleData, at) : null;
      const until = scheduleData && onCall ? onCallUntil(scheduleData, at) : null;
      const people = await loadUsers(onCall ? [onCall.userId] : []);
      return { at, onCall: describeOnCall(onCall, people), until };
    },
  );

  // The timeline: back-to-back shifts between from and to (default: the next 14 days)
  app.get<{ Params: ScheduleParams }>(
    "/schedules/:scheduleId/shifts",
    { preHandler: [requireAuth, requireScheduleRole("member")] },
    async (request) => {
      const { from, to } = parse(RangeSchema, request.query);
      const data = await loadScheduleData([request.schedule.id], from, to);
      const scheduleData = data.get(request.schedule.id);
      const shifts = scheduleData ? shiftsBetween(scheduleData, from, to) : [];
      const people = await loadUsers(shifts.flatMap((s) => (s.onCall ? [s.onCall.userId] : [])));
      return {
        from,
        to,
        shifts: shifts.map((shift) => ({
          start: shift.start,
          end: shift.end,
          onCall: describeOnCall(shift.onCall, people),
        })),
      };
    },
  );

  // ---------- Layers ----------

  // A new layer goes on top of the existing ones
  app.post<{ Params: ScheduleParams }>(
    "/schedules/:scheduleId/layers",
    { preHandler: [requireAuth, requireScheduleRole("admin")] },
    async (request, reply) => {
      const body = parse(CreateLayerSchema, request.body);
      const schedule = request.schedule;
      await assertMembers(schedule.orgId, body.participants);

      const layer = await db.transaction(async (tx) => {
        await lockSchedule(tx, schedule.id);
        const [top] = await tx
          .select({ position: max(scheduleLayers.position) })
          .from(scheduleLayers)
          .where(eq(scheduleLayers.scheduleId, schedule.id));
        const isBottom = top?.position === null || top?.position === undefined;
        if (isBottom && body.restriction) throw bottomLayerError();

        const { participants, ...fields } = body;
        const [created] = await tx
          .insert(scheduleLayers)
          .values({
            ...fields,
            shiftLengthHours: fields.rotationType === "custom" ? fields.shiftLengthHours : null,
            scheduleId: schedule.id,
            position: isBottom ? 0 : (top?.position ?? 0) + 1,
          })
          .returning();
        if (!created) throw new Error("layer not created");
        await replaceParticipants(tx, created.id, participants);
        return created;
      });
      return reply.code(201).send({ layer });
    },
  );

  app.patch<{ Params: LayerParams }>(
    "/schedules/:scheduleId/layers/:layerId",
    { preHandler: [requireAuth, requireScheduleRole("admin")] },
    async (request) => {
      const changes = parse(UpdateLayerSchema, request.body);
      const schedule = request.schedule;
      if (changes.participants) await assertMembers(schedule.orgId, changes.participants);

      const layer = await db.transaction(async (tx) => {
        await lockSchedule(tx, schedule.id);
        const layers = await layersOf(tx, schedule.id);
        const existing = layers.find((l) => l.id === request.params.layerId);
        if (!existing) throw layerNotFound();

        const { participants, ...fields } = changes;
        const merged = { ...existing, ...fields };
        if (!customNeedsLength(merged))
          throw new AppError(400, "VALIDATION_ERROR", LENGTH_MESSAGE.message);
        if (layers[0]?.id === existing.id && merged.restriction) throw bottomLayerError();

        const [updated] = await tx
          .update(scheduleLayers)
          .set({
            ...fields,
            shiftLengthHours: merged.rotationType === "custom" ? merged.shiftLengthHours : null,
            updatedAt: new Date(),
          })
          .where(eq(scheduleLayers.id, existing.id))
          .returning();
        if (participants) await replaceParticipants(tx, existing.id, participants);
        return updated;
      });
      return { layer };
    },
  );

  app.delete<{ Params: LayerParams }>(
    "/schedules/:scheduleId/layers/:layerId",
    { preHandler: [requireAuth, requireScheduleRole("admin")] },
    async (request, reply) => {
      await db.transaction(async (tx) => {
        await lockSchedule(tx, request.schedule.id);
        const layers = await layersOf(tx, request.schedule.id);
        const index = layers.findIndex((l) => l.id === request.params.layerId);
        if (index === -1) throw layerNotFound();
        // Deleting the bottom layer would make the next one the bottom: it must be unrestricted too
        if (index === 0 && layers[1]?.restriction) throw bottomLayerError();
        await tx.delete(scheduleLayers).where(eq(scheduleLayers.id, request.params.layerId));
      });
      return reply.code(204).send();
    },
  );

  // ---------- Overrides ----------

  // Anyone can cover a shift themselves; only admins can put someone else on call
  app.post<{ Params: ScheduleParams }>(
    "/schedules/:scheduleId/overrides",
    { preHandler: [requireAuth, requireScheduleRole("member")] },
    async (request, reply) => {
      const body = parse(CreateOverrideSchema, request.body);
      const userId = body.userId ?? request.user.id;
      if (userId !== request.user.id && !hasRole(request.membership.role, "admin")) {
        throw forbidden("admin");
      }
      await assertMembers(request.schedule.orgId, [userId]);

      const [override] = await db
        .insert(scheduleOverrides)
        .values({
          scheduleId: request.schedule.id,
          userId,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          createdBy: request.user.id,
        })
        .returning();
      return reply.code(201).send({ override });
    },
  );

  app.delete<{ Params: OverrideParams }>(
    "/schedules/:scheduleId/overrides/:overrideId",
    { preHandler: [requireAuth, requireScheduleRole("member")] },
    async (request: FastifyRequest<{ Params: OverrideParams }>, reply) => {
      const notFound = new AppError(404, "OVERRIDE_NOT_FOUND", "Override not found");
      if (!z.uuid().safeParse(request.params.overrideId).success) throw notFound;
      const [override] = await db
        .select()
        .from(scheduleOverrides)
        .where(
          and(
            eq(scheduleOverrides.id, request.params.overrideId),
            eq(scheduleOverrides.scheduleId, request.schedule.id),
          ),
        );
      if (!override) throw notFound;
      if (override.userId !== request.user.id && !hasRole(request.membership.role, "admin")) {
        throw forbidden("admin");
      }
      await db.delete(scheduleOverrides).where(eq(scheduleOverrides.id, override.id));
      return reply.code(204).send();
    },
  );
}
