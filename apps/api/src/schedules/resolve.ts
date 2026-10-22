import { DateTime } from "luxon";
import type { LayerRestriction, RotationType } from "./types.js";

// Everything the resolver needs, already loaded from the database.
// These are plain functions with no database access, so the tricky time math is easy to test.
export type LayerData = {
  id: string;
  name: string;
  position: number; // higher = on top
  rotationType: RotationType;
  shiftLengthHours: number | null;
  handoffTime: string; // "HH:MM" local
  startDate: string; // "YYYY-MM-DD" local
  restriction: LayerRestriction | null;
  participants: string[]; // user ids, in turn order
};

export type OverrideData = {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
};

export type ScheduleData = { timezone: string; layers: LayerData[]; overrides: OverrideData[] };

export type OnCall =
  | { userId: string; source: "override"; overrideId: string }
  | { userId: string; source: "layer"; layerId: string; layerName: string };

export type Shift = { start: Date; end: Date; onCall: OnCall | null };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const MAX_RANGE_MS = 31 * DAY; // the longest timeline we compute at once

const parseTime = (hhmm: string) => {
  const [hour = 0, minute = 0] = hhmm.split(":").map(Number);
  return { hour, minute, second: 0, millisecond: 0 };
};

const minutesOf = (hhmm: string) => {
  const { hour, minute } = parseTime(hhmm);
  return hour * 60 + minute;
};

// a % b that is never negative: mod(-1, 3) = 2 (JavaScript's -1 % 3 is -1)
const mod = (a: number, b: number) => ((a % b) + b) % b;

// A calendar day as a plain number, so "days between" ignores DST (a DST day has 23 or 25 hours)
const dayNumber = (dt: DateTime) => Date.UTC(dt.year, dt.month - 1, dt.day) / DAY;

// When the layer's first shift starts: its start date at the handoff time, on the local clock
function rotationStart(layer: LayerData, zone: string) {
  return DateTime.fromISO(layer.startDate, { zone }).set(parseTime(layer.handoffTime));
}

// Which turn is running at `at` (0 = the first shift; negative = before the start date,
// the rotation simply extends backwards), and when that turn starts and ends.
export function shiftAt(layer: LayerData, zone: string, at: DateTime) {
  const first = rotationStart(layer, zone);

  if (layer.rotationType === "custom") {
    // Real elapsed hours: a 12-hour shift is 12 hours even across a DST change
    const length = (layer.shiftLengthHours ?? 24) * HOUR;
    const index = Math.floor((at.toMillis() - first.toMillis()) / length);
    return {
      index,
      start: first.plus({ milliseconds: index * length }),
      end: first.plus({ milliseconds: (index + 1) * length }),
    };
  }

  // Daily/weekly: count calendar days on the local clock, so the handoff stays at
  // 09:00 local before and after the clocks change
  const days = layer.rotationType === "daily" ? 1 : 7;
  const local = at.setZone(zone);
  let elapsedDays = dayNumber(local) - dayNumber(first);
  if (local < local.set(parseTime(layer.handoffTime))) elapsedDays -= 1; // before today's handoff
  const index = Math.floor(elapsedDays / days);
  return {
    index,
    start: first.plus({ days: index * days }),
    end: first.plus({ days: (index + 1) * days }),
  };
}

// Is a restricted layer active at this local time?
export function restrictionActive(restriction: LayerRestriction, local: DateTime) {
  const minute = local.hour * 60 + local.minute;
  const start = minutesOf(restriction.start);
  const end = minutesOf(restriction.end);
  const onDay = (dt: DateTime) => restriction.days.includes(dt.weekday);

  if (start === end) return onDay(local); // the whole day
  if (start < end) return onDay(local) && minute >= start && minute < end;
  // Crosses midnight (22:00 → 06:00): the early hours belong to the day it started on
  if (minute >= start) return onDay(local);
  if (minute < end) return onDay(local.minus({ days: 1 }));
  return false;
}

// THE question: who is on call at this moment?
// 1. An override covering this moment wins (the newest one, if several overlap).
// 2. Otherwise the highest layer that is active now picks whose turn it is.
// The bottom layer has no restriction (the API enforces it), so as long as it has
// people in it, there is always exactly one answer.
export function getOnCall(schedule: ScheduleData, at: Date): OnCall | null {
  const time = at.getTime();
  const override = schedule.overrides
    .filter((o) => o.startsAt.getTime() <= time && time < o.endsAt.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (override) return { userId: override.userId, source: "override", overrideId: override.id };

  const local = DateTime.fromJSDate(at, { zone: schedule.timezone });
  const topFirst = [...schedule.layers].sort((a, b) => b.position - a.position);
  for (const layer of topFirst) {
    if (layer.participants.length === 0) continue;
    if (layer.restriction && !restrictionActive(layer.restriction, local)) continue;
    const { index } = shiftAt(layer, schedule.timezone, local);
    const userId = layer.participants[mod(index, layer.participants.length)];
    if (userId) return { userId, source: "layer", layerId: layer.id, layerName: layer.name };
  }
  return null;
}

// Two answers are "the same shift" if the same person is on call for the same reason
const shiftKey = (onCall: OnCall | null) =>
  onCall
    ? `${onCall.userId}:${onCall.source === "override" ? onCall.overrideId : onCall.layerId}`
    : "nobody";

// Every moment in [from, to) where the answer *might* change: handoffs,
// restriction windows opening/closing, overrides starting/ending.
function boundaries(schedule: ScheduleData, from: Date, to: Date) {
  const zone = schedule.timezone;
  const points = new Set<number>([from.getTime(), to.getTime()]);
  const add = (dt: DateTime | Date) => {
    const time = dt instanceof Date ? dt.getTime() : dt.toMillis();
    if (time > from.getTime() && time < to.getTime()) points.add(time);
  };

  for (const o of schedule.overrides) {
    add(o.startsAt);
    add(o.endsAt);
  }

  const fromLocal = DateTime.fromJSDate(from, { zone });
  for (const layer of schedule.layers) {
    // Handoffs: walk shift by shift from the one running at `from`
    let shift = shiftAt(layer, zone, fromLocal);
    for (let i = 0; i < 5_000 && shift.end.toMillis() < to.getTime(); i++) {
      add(shift.end);
      shift = shiftAt(layer, zone, shift.end);
    }

    // Restriction windows: when they open and close on each local day
    const r = layer.restriction;
    if (!r) continue;
    const [start, end] = [parseTime(r.start), parseTime(r.end)];
    for (
      let day = fromLocal.startOf("day").minus({ days: 1 });
      day.toMillis() < to.getTime();
      day = day.plus({ days: 1 })
    ) {
      add(day.set(start));
      add(minutesOf(r.end) > minutesOf(r.start) ? day.set(end) : day.plus({ days: 1 }).set(end));
    }
  }

  return [...points].sort((a, b) => a - b);
}

// The timeline: who is on call from `from` to `to`, as back-to-back shifts.
// Between two neighbouring boundaries nothing changes, so asking getOnCall
// once per piece is enough. Neighbouring pieces with the same answer are merged.
export function shiftsBetween(schedule: ScheduleData, from: Date, to: Date): Shift[] {
  const points = boundaries(schedule, from, to);
  const shifts: Shift[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    const onCall = getOnCall(schedule, new Date(start));
    const last = shifts.at(-1);
    if (last && shiftKey(last.onCall) === shiftKey(onCall)) {
      last.end = new Date(end);
    } else {
      shifts.push({ start: new Date(start), end: new Date(end), onCall });
    }
  }
  return shifts;
}

// "On call until when?": the end of the current piece of the timeline
// (null if nothing changes for a month)
export function onCallUntil(schedule: ScheduleData, at: Date): Date | null {
  const horizon = new Date(at.getTime() + MAX_RANGE_MS);
  const [current] = shiftsBetween(schedule, at, horizon);
  return current && current.end.getTime() < horizon.getTime() ? current.end : null;
}
