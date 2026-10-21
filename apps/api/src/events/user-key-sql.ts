import { sql } from "drizzle-orm";
import { events } from "../db/schema.js";

// SQL version of userKey() in issue-details.ts: one key per person, best identifier first.
// Use it to count distinct users across events: count(distinct eventUserKey).
export const eventUserKey = sql`coalesce(
  'id:' || (${events.user}->>'id'),
  'email:' || lower(${events.user}->>'email'),
  'ip:' || (${events.user}->>'ip')
)`;
