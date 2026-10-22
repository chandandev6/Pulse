import type { OnCallSource } from "./responder.js";

// What can happen to an incident, in the order it usually happens.
// Stored as text (not a Postgres enum), so F14 can add "escalated" without a migration.
export const TIMELINE_KINDS = ["triggered", "notified", "acknowledged", "resolved"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export type TimelineData = {
  triggered: { ruleId: string | null; ruleName: string }; // ruleId is null for a deleted rule
  notified: {
    // Who was asked to respond first (null = nobody was on call)
    responder: { id: string; name: string; source: OnCallSource } | null;
    // true = every member was told: nobody on call, or the responder has no channel for it
    everyone: boolean;
    channels: number; // how many channels got a message
  };
  acknowledged: { via: "dashboard" | "link" };
  resolved: { resolvedIssue: boolean };
};
