// How often a layer hands over to the next person:
// - daily / weekly: every 1 / 7 days at the handoff time, on the schedule's local clock
// - custom: every N hours of real time (e.g. 12-hour shifts)
export const ROTATION_TYPES = ["daily", "weekly", "custom"] as const;
export type RotationType = (typeof ROTATION_TYPES)[number];

// "Only on weekdays from 09:00 to 17:00" (local time). days: 1 = Monday ... 7 = Sunday.
// end < start means the window crosses midnight (e.g. 22:00 → 06:00).
export type LayerRestriction = {
  days: number[];
  start: string; // "HH:MM"
  end: string; // "HH:MM"
};
