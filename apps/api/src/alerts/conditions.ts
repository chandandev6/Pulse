import { z } from "zod";

// What can make a rule fire. Stored as JSON in alert_rules.conditions, so adding
// a new kind later needs no migration: just a new entry here.
export const ConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("new_issue") }), // the first event of a new issue
  z.object({ type: z.literal("regression") }), // a resolved issue came back
  z.object({ type: z.literal("severity_critical") }), // the issue's severity is critical
  z.object({
    type: z.literal("event_frequency"), // more than N events in the last X minutes
    count: z.number().int().min(1).max(1_000_000),
    minutes: z.number().int().min(1).max(1_440), // up to one day
  }),
  z.object({
    type: z.literal("user_count"), // more than N different users affected
    count: z.number().int().min(1).max(10_000_000),
  }),
]);

export type AlertCondition = z.infer<typeof ConditionSchema>;
export const CONDITION_TYPES = ConditionSchema.options.map((option) => option.shape.type.value);

// "all": every condition must be true. "any": one is enough.
export const MATCH_MODES = ["all", "any"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];
