import type { OnCallSource } from "./responder.js";

// What can happen to an incident, in the order it usually happens.
// Stored as text (not a Postgres enum), so new kinds need no migration.
export const TIMELINE_KINDS = [
  "triggered",
  "notified",
  "escalated", // F14: nobody acknowledged in time, so the next level was told (can repeat)
  "exhausted", // F14: every level (and repeat) was tried, nobody acknowledged
  "acknowledged",
  "resolved",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

// Someone an escalation level reached, directly or through a schedule
export type EscalationTarget = {
  id: string;
  name: string;
  schedule: { id: string; name: string } | null; // set when they were on call there
};

export type TimelineData = {
  triggered: { ruleId: string | null; ruleName: string }; // ruleId is null for a deleted rule
  notified: {
    // Who was asked to respond first (null = nobody was on call)
    responder: { id: string; name: string; source: OnCallSource } | null;
    // true = every member was told: nobody on call, or the responder has no channel for it
    everyone: boolean;
    channels: number; // how many channels got a message
    // F14: set when an escalation policy picked who to tell (its level 1)
    escalation?: { policy: { id: string; name: string }; targets: EscalationTarget[] };
  };
  escalated: {
    step: number; // 1 = the first escalation
    level: number; // 1-based level of the policy
    pass: number; // 1 = first time through the levels, 2 = first repeat, ...
    targets: EscalationTarget[];
    channels: number;
  };
  exhausted: { levels: number; passes: number };
  acknowledged: { via: "dashboard" | "link" };
  resolved: { resolvedIssue: boolean };
};
