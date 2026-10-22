import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { scheduleLayerParticipants } from "../src/db/schema.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "schedtest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let member: TestUser;
let leaver: TestUser;
let outsider: TestUser;

function as(
  user: TestUser,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: object,
) {
  return app.inject({ method, url, cookies: user.cookies, payload: body });
}

async function newSchedule(timezone = "Asia/Kolkata") {
  const res = await as(owner, "POST", `/orgs/${owner.org.id}/schedules`, {
    name: `Primary ${crypto.randomUUID().slice(0, 6)}`,
    timezone,
  });
  expect(res.statusCode).toBe(201);
  return res.json().schedule.id as string;
}

// Daily rotation starting 2026-10-01 09:00 IST: owner, member, leaver, owner, ...
async function addBaseLayer(scheduleId: string, participants: string[]) {
  const res = await as(owner, "POST", `/schedules/${scheduleId}/layers`, {
    name: "Base",
    rotationType: "daily",
    handoffTime: "09:00",
    startDate: "2026-10-01",
    participants,
  });
  expect(res.statusCode).toBe(201);
  return res.json().layer.id as string;
}

const onCallAt = async (scheduleId: string, at: string) =>
  (await as(member, "GET", `/schedules/${scheduleId}/oncall?at=${encodeURIComponent(at)}`)).json();

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  member = await createTestUser(email("member"), "Member");
  leaver = await createTestUser(email("leaver"), "Leaver");
  outsider = await createTestUser(email("outsider"), "Outsider");
  for (const user of [member, leaver]) {
    await as(owner, "POST", `/orgs/${owner.org.id}/members`, { email: user.user.email });
  }
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("schedules", () => {
  it("admins create them; timezones are checked; outsiders can't see them", async () => {
    const url = `/orgs/${owner.org.id}/schedules`;
    expect((await as(owner, "POST", url, { name: "X", timezone: "Mars/Olympus" })).statusCode).toBe(
      400,
    );
    expect((await as(member, "POST", url, { name: "X", timezone: "UTC" })).statusCode).toBe(403);

    const id = await newSchedule();
    expect((await as(outsider, "GET", `/schedules/${id}`)).statusCode).toBe(404);
    expect((await as(member, "GET", `/schedules/${id}`)).json()).toMatchObject({
      schedule: { id, timezone: "Asia/Kolkata", onCall: null },
      layers: [],
    });
  });

  it("answers who is on call at any moment, with the rotation and handoff", async () => {
    const id = await newSchedule();
    await addBaseLayer(id, [owner.user.id, member.user.id]);

    expect((await onCallAt(id, "2026-10-01T10:00:00+05:30")).onCall).toMatchObject({
      user: { id: owner.user.id, name: "Owner" },
      source: "layer",
      layer: { name: "Base" },
    });
    const beforeHandoff = await onCallAt(id, "2026-10-02T08:59:00+05:30");
    expect(beforeHandoff.onCall.user.id).toBe(owner.user.id);
    expect(beforeHandoff.until).toBe("2026-10-02T03:30:00.000Z"); // 09:00 IST
    expect((await onCallAt(id, "2026-10-02T09:00:00+05:30")).onCall.user.id).toBe(member.user.id);
  });

  it("the timeline has back-to-back shifts and refuses huge ranges", async () => {
    const id = await newSchedule();
    await addBaseLayer(id, [owner.user.id, member.user.id]);

    const res = await as(
      member,
      "GET",
      `/schedules/${id}/shifts?from=2026-10-01T03:30:00Z&to=2026-10-04T03:30:00Z`,
    );
    const shifts = res.json().shifts;
    expect(shifts.map((s: { onCall: { user: { name: string } } }) => s.onCall.user.name)).toEqual([
      "Owner",
      "Member",
      "Owner",
    ]);
    expect(shifts[1].start).toBe(shifts[0].end);

    const tooLong = await as(
      member,
      "GET",
      `/schedules/${id}/shifts?from=2026-10-01T00:00:00Z&to=2026-12-01T00:00:00Z`,
    );
    expect(tooLong.statusCode).toBe(400);
  });
});

describe("layers", () => {
  it("the bottom layer can't be restricted; time-limited layers go on top", async () => {
    const id = await newSchedule();
    const businessHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
    const restrictedFirst = await as(owner, "POST", `/schedules/${id}/layers`, {
      name: "Day",
      rotationType: "daily",
      startDate: "2026-10-01",
      participants: [member.user.id],
      restriction: businessHours,
    });
    expect(restrictedFirst.json().error.code).toBe("BOTTOM_LAYER_RESTRICTED");

    const base = await addBaseLayer(id, [owner.user.id]);
    const top = await as(owner, "POST", `/schedules/${id}/layers`, {
      name: "Day",
      rotationType: "weekly",
      startDate: "2026-10-05",
      participants: [member.user.id],
      restriction: businessHours,
    });
    expect(top.json().layer).toMatchObject({ position: 1 });

    // Monday 10:00 IST → the business-hours layer; 20:00 → the base layer
    expect((await onCallAt(id, "2026-10-05T10:00:00+05:30")).onCall.user.id).toBe(member.user.id);
    expect((await onCallAt(id, "2026-10-05T20:00:00+05:30")).onCall.user.id).toBe(owner.user.id);

    // Removing the base would leave a restricted layer at the bottom
    expect((await as(owner, "DELETE", `/schedules/${id}/layers/${base}`)).statusCode).toBe(400);
    expect(
      (
        await as(owner, "PATCH", `/schedules/${id}/layers/${base}`, {
          restriction: businessHours,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("only members of the org can be on call; custom rotations need a length", async () => {
    const id = await newSchedule();
    const notMember = await as(owner, "POST", `/schedules/${id}/layers`, {
      name: "Base",
      rotationType: "daily",
      startDate: "2026-10-01",
      participants: [outsider.user.id],
    });
    expect(notMember.json().error.code).toBe("NOT_A_MEMBER");

    const noLength = await as(owner, "POST", `/schedules/${id}/layers`, {
      name: "Base",
      rotationType: "custom",
      startDate: "2026-10-01",
      participants: [owner.user.id],
    });
    expect(noLength.statusCode).toBe(400);
  });
});

describe("overrides", () => {
  it("members cover shifts themselves; only admins assign others", async () => {
    const id = await newSchedule();
    await addBaseLayer(id, [owner.user.id]);
    const period = { startsAt: "2026-10-10T00:00:00Z", endsAt: "2026-10-11T00:00:00Z" };

    const forOther = await as(member, "POST", `/schedules/${id}/overrides`, {
      ...period,
      userId: owner.user.id,
    });
    expect(forOther.statusCode).toBe(403);

    const mine = await as(member, "POST", `/schedules/${id}/overrides`, period);
    expect(mine.statusCode).toBe(201);
    expect((await onCallAt(id, "2026-10-10T12:00:00Z")).onCall).toMatchObject({
      user: { id: member.user.id },
      source: "override",
    });
    expect((await onCallAt(id, "2026-10-11T00:00:00Z")).onCall.user.id).toBe(owner.user.id);

    const backwards = await as(member, "POST", `/schedules/${id}/overrides`, {
      startsAt: period.endsAt,
      endsAt: period.startsAt,
    });
    expect(backwards.statusCode).toBe(400);

    const overrideId = mine.json().override.id;
    expect(
      (await as(member, "DELETE", `/schedules/${id}/overrides/${overrideId}`)).statusCode,
    ).toBe(204);
    expect((await onCallAt(id, "2026-10-10T12:00:00Z")).onCall.user.id).toBe(owner.user.id);
  });
});

describe("who's on call now", () => {
  it("lists every schedule of the org with its current person", async () => {
    const id = await newSchedule();
    await addBaseLayer(id, [member.user.id]);
    const res = await as(member, "GET", `/orgs/${owner.org.id}/oncall`);
    expect(res.json().oncall).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schedule: expect.objectContaining({ id }),
          onCall: expect.objectContaining({
            user: expect.objectContaining({ id: member.user.id }),
          }),
        }),
      ]),
    );
  });

  it("someone who leaves the org drops out of rotations; the others keep their order", async () => {
    const id = await newSchedule();
    const layerId = await addBaseLayer(id, [owner.user.id, leaver.user.id, member.user.id]);

    expect(
      (await as(leaver, "DELETE", `/orgs/${owner.org.id}/members/${leaver.user.id}`)).statusCode,
    ).toBe(204);

    const rows = await db
      .select()
      .from(scheduleLayerParticipants)
      .where(eq(scheduleLayerParticipants.layerId, layerId))
      .orderBy(scheduleLayerParticipants.position);
    expect(rows.map((r) => [r.position, r.userId])).toEqual([
      [0, owner.user.id],
      [1, member.user.id],
    ]);
    // Oct 2 was the leaver's day; with two people left it's the member's
    expect((await onCallAt(id, "2026-10-02T10:00:00+05:30")).onCall.user.id).toBe(member.user.id);
  });
});
