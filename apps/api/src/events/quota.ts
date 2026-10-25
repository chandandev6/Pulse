import { config } from "../config.js";
import { AppError } from "../errors.js";
import { redis } from "../redis.js";

export const INGEST_NAMESPACE = "pulse-ingest:";

export type IngestLimits = {
  id: string;
  rateLimitPerMinute: number;
  monthlyQuota: number | null;
};

// Both counters in one Lua script, so Redis runs it as one step (no other request in between):
// 1. count this event in the current minute; over the limit → refuse
// 2. count it in the current month; over the quota → undo and refuse
// An event refused by the rate limit doesn't use up the monthly quota.
const SCRIPT = `
local minute = redis.call("INCR", KEYS[1])
if minute == 1 then redis.call("EXPIRE", KEYS[1], 120) end
if minute > tonumber(ARGV[1]) then return 1 end
local quota = tonumber(ARGV[2])
local month = redis.call("INCR", KEYS[2])
if month == 1 then redis.call("EXPIRE", KEYS[2], 3024000) end
if quota > 0 and month > quota then
  redis.call("DECR", KEYS[2])
  return 2
end
return 0
`;

const monthKey = (now: Date) => now.toISOString().slice(0, 7); // "2026-10"

export function quotaKeys(projectId: string, now: Date) {
  const minute = Math.floor(now.getTime() / 60_000);
  return {
    minute: `${INGEST_NAMESPACE}rate:${projectId}:${minute}`,
    month: `${INGEST_NAMESPACE}quota:${projectId}:${monthKey(now)}`,
  };
}

// How many events the project has sent this month (for the settings page)
export async function monthlyUsage(projectId: string, now = new Date()): Promise<number> {
  try {
    return Number((await redis.get(quotaKeys(projectId, now).month)) ?? 0);
  } catch {
    return 0;
  }
}

// The project's own settings, held under the server's ceilings (MAX_EVENTS_PER_MINUTE,
// MAX_MONTHLY_QUOTA), so values saved before a ceiling existed can't get around it
export function effectiveLimits(project: IngestLimits, settings = config): IngestLimits {
  const maxRate = settings.MAX_EVENTS_PER_MINUTE;
  const maxQuota = settings.MAX_MONTHLY_QUOTA;
  return {
    id: project.id,
    rateLimitPerMinute: maxRate
      ? Math.min(project.rateLimitPerMinute, maxRate)
      : project.rateLimitPerMinute,
    monthlyQuota: maxQuota
      ? Math.min(project.monthlyQuota ?? maxQuota, maxQuota)
      : project.monthlyQuota,
  };
}

// Throws 429 with a Retry-After the SDK can respect
export async function checkIngestLimits(saved: IngestLimits, now = new Date()) {
  const project = effectiveLimits(saved);
  const keys = quotaKeys(project.id, now);
  let result: number;
  try {
    result = Number(
      await redis.eval(
        SCRIPT,
        2,
        keys.minute,
        keys.month,
        project.rateLimitPerMinute,
        project.monthlyQuota ?? 0,
      ),
    );
  } catch {
    return; // Redis trouble: let events through rather than drop them (same as rate-limit.ts)
  }

  if (result === 1) {
    const retryAfter = 60 - now.getUTCSeconds();
    throw new AppError(
      429,
      "PROJECT_RATE_LIMITED",
      `This project sends more than ${project.rateLimitPerMinute} events per minute`,
      retryAfter,
    );
  }
  if (result === 2) {
    const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    throw new AppError(
      429,
      "QUOTA_EXCEEDED",
      `This project used its quota of ${project.monthlyQuota} events this month`,
      Math.ceil((nextMonth - now.getTime()) / 1000),
    );
  }
}
