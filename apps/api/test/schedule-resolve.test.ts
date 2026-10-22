import { describe, expect, it } from "vitest";
import {
  getOnCall,
  type LayerData,
  onCallUntil,
  type ScheduleData,
  shiftsBetween,
} from "../src/schedules/resolve.js";

// No database here: the resolver is plain functions, so we feed it plain data

const layer = (extra: Partial<LayerData>): LayerData => ({
  id: "base",
  name: "Base",
  position: 0,
  rotationType: "daily",
  shiftLengthHours: null,
  handoffTime: "09:00",
  startDate: "2026-10-01",
  restriction: null,
  participants: ["ana", "ben", "cai"],
  ...extra,
});

const schedule = (
  timezone: string,
  layers: LayerData[],
  overrides: ScheduleData["overrides"] = [],
) => ({
  timezone,
  layers,
  overrides,
});

const who = (s: ScheduleData, iso: string) => getOnCall(s, new Date(iso))?.userId ?? null;

describe("rotations", () => {
  it("daily: hands over at the local handoff time and wraps around", () => {
    const s = schedule("Asia/Kolkata", [layer({})]); // IST = UTC+05:30
    expect(who(s, "2026-10-01T10:00:00+05:30")).toBe("ana");
    expect(who(s, "2026-10-02T08:59:00+05:30")).toBe("ana"); // still ana's shift
    expect(who(s, "2026-10-02T09:00:00+05:30")).toBe("ben"); // handoff
    expect(who(s, "2026-10-03T09:00:00+05:30")).toBe("cai");
    expect(who(s, "2026-10-04T09:00:00+05:30")).toBe("ana"); // back to the start
    // Before the start date the rotation runs backwards
    expect(who(s, "2026-09-30T10:00:00+05:30")).toBe("cai");
  });

  it("weekly: one person per week, handing over on the start date's weekday", () => {
    const s = schedule("UTC", [
      layer({ rotationType: "weekly", startDate: "2026-10-05", handoffTime: "10:00" }),
    ]);
    expect(who(s, "2026-10-05T10:00:00Z")).toBe("ana");
    expect(who(s, "2026-10-12T09:59:00Z")).toBe("ana");
    expect(who(s, "2026-10-12T10:00:00Z")).toBe("ben");
    expect(who(s, "2026-10-26T10:00:00Z")).toBe("ana");
  });

  it("daily handoffs stay at 09:00 local when the clocks change (DST)", () => {
    // New York leaves summer time on 2026-11-01: 09:00 is 13:00 UTC before, 14:00 UTC after
    const s = schedule("America/New_York", [layer({ startDate: "2026-10-31" })]);
    expect(who(s, "2026-10-31T13:00:00Z")).toBe("ana"); // 09:00 EDT
    expect(who(s, "2026-11-01T13:30:00Z")).toBe("ana"); // 08:30 EST: not yet
    expect(who(s, "2026-11-01T14:00:00Z")).toBe("ben"); // 09:00 EST

    const [shift] = shiftsBetween(
      s,
      new Date("2026-10-31T13:00:00Z"),
      new Date("2026-11-02T00:00:00Z"),
    );
    expect(shift?.end.toISOString()).toBe("2026-11-01T14:00:00.000Z"); // a 25-hour shift
  });

  it("custom: shifts of N real hours, even across DST", () => {
    const s = schedule("America/New_York", [
      layer({
        rotationType: "custom",
        shiftLengthHours: 12,
        startDate: "2026-10-31",
        handoffTime: "08:00",
      }),
    ]);
    const shifts = shiftsBetween(
      s,
      new Date("2026-10-31T12:00:00Z"),
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(shifts.map((x) => x.onCall?.userId)).toEqual(["ana", "ben", "cai", "ana"]);
    for (const x of shifts) expect(x.end.getTime() - x.start.getTime()).toBe(12 * 3600_000);
  });
});

describe("layers and overrides", () => {
  const business = layer({
    id: "day",
    name: "Business hours",
    position: 1,
    participants: ["dev"],
    restriction: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  });
  const nights = layer({
    id: "night",
    name: "Friday night",
    position: 2,
    participants: ["nia"],
    restriction: { days: [5], start: "22:00", end: "06:00" },
  });
  const s = schedule("UTC", [layer({}), business, nights]);

  it("the highest active layer wins", () => {
    expect(who(s, "2026-10-05T10:00:00Z")).toBe("dev"); // Monday, business hours
    expect(getOnCall(s, new Date("2026-10-05T10:00:00Z"))).toMatchObject({
      source: "layer",
      layerName: "Business hours",
    });
    expect(who(s, "2026-10-05T17:00:00Z")).toBe("ben"); // 17:00: window closed (end is exclusive), base layer: Oct 5 is ben
    expect(who(s, "2026-10-10T10:00:00Z")).not.toBe("dev"); // Saturday
  });

  it("windows across midnight belong to the day they start", () => {
    expect(who(s, "2026-10-09T23:00:00Z")).toBe("nia"); // Friday 23:00
    expect(who(s, "2026-10-10T05:59:00Z")).toBe("nia"); // Saturday early morning
    expect(who(s, "2026-10-10T06:00:00Z")).not.toBe("nia");
    expect(who(s, "2026-10-11T03:00:00Z")).not.toBe("nia"); // Sunday early morning: Saturday isn't in days
  });

  it("an override beats every layer; the newest overlapping one wins", () => {
    const withOverrides = schedule(
      "UTC",
      [layer({}), business],
      [
        {
          id: "o1",
          userId: "zoe",
          startsAt: new Date("2026-10-05T08:00:00Z"),
          endsAt: new Date("2026-10-05T12:00:00Z"),
          createdAt: new Date("2026-10-01T00:00:00Z"),
        },
        {
          id: "o2",
          userId: "yan",
          startsAt: new Date("2026-10-05T11:00:00Z"),
          endsAt: new Date("2026-10-05T13:00:00Z"),
          createdAt: new Date("2026-10-02T00:00:00Z"),
        },
      ],
    );
    expect(who(withOverrides, "2026-10-05T10:00:00Z")).toBe("zoe");
    expect(who(withOverrides, "2026-10-05T11:30:00Z")).toBe("yan");
    expect(who(withOverrides, "2026-10-05T13:00:00Z")).toBe("dev"); // the override ended

    expect(onCallUntil(withOverrides, new Date("2026-10-05T10:00:00Z"))?.toISOString()).toBe(
      "2026-10-05T11:00:00.000Z",
    );
  });
});

describe("exactly one on-call user", () => {
  it("at every moment of a year, with stacked layers, DST and overrides", () => {
    const s = schedule(
      "Europe/London",
      [
        layer({ rotationType: "weekly" }),
        layer({
          id: "l2",
          position: 1,
          participants: ["x", "y"],
          restriction: { days: [1, 3, 5], start: "18:00", end: "02:30" },
        }),
        layer({
          id: "l3",
          position: 2,
          rotationType: "custom",
          shiftLengthHours: 7,
          participants: ["p", "q", "r"],
          restriction: { days: [6, 7], start: "00:00", end: "00:00" },
        }),
      ],
      [
        {
          id: "o",
          userId: "zoe",
          startsAt: new Date("2026-03-29T00:30:00Z"),
          endsAt: new Date("2026-03-29T03:00:00Z"),
          createdAt: new Date(),
        },
      ],
    );

    // 2000 random moments: always exactly one person
    let time = new Date("2026-01-01T00:00:00Z").getTime();
    for (let i = 0; i < 2000; i++) {
      time += Math.floor(Math.random() * 5 * 3600_000);
      expect(getOnCall(s, new Date(time))).not.toBeNull();
    }

    // The timeline covers the whole range with no gaps or overlaps, across the March DST change
    const from = new Date("2026-03-20T00:00:00Z");
    const to = new Date("2026-04-15T00:00:00Z");
    const shifts = shiftsBetween(s, from, to);
    expect(shifts[0]?.start).toEqual(from);
    expect(shifts.at(-1)?.end).toEqual(to);
    for (let i = 1; i < shifts.length; i++) {
      expect(shifts[i]?.start).toEqual(shifts[i - 1]?.end);
      expect(shifts[i]?.onCall).not.toBeNull();
    }
    // Spot-check each piece against the direct answer
    for (const shift of shifts) {
      const middle = new Date((shift.start.getTime() + shift.end.getTime()) / 2);
      expect(getOnCall(s, middle)?.userId).toBe(shift.onCall?.userId);
    }
  });

  it("an empty schedule has nobody", () => {
    expect(getOnCall(schedule("UTC", []), new Date())).toBeNull();
  });
});
