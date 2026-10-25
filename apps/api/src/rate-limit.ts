import type { RateLimitPluginOptions } from "@fastify/rate-limit";
import { AppError } from "./errors.js";
import { redis } from "./redis.js";

export const RATE_LIMIT_NAMESPACE = "pulse-ratelimit:";

// Counters live in Redis, so limits survive restarts and are shared by every API instance.
// global: false means only routes that set `config.rateLimit` are limited.
export const rateLimitOptions: RateLimitPluginOptions = {
  global: false,
  redis,
  nameSpace: RATE_LIMIT_NAMESPACE,
  hook: "preHandler", // run after the body is parsed, so keys can use the email
  skipOnError: true, // if Redis is down, let requests through instead of locking everyone out
  errorResponseBuilder: (_request, context) =>
    new AppError(429, "RATE_LIMITED", `Too many attempts. Try again in ${context.after}`),
};

// Limits that don't depend on the client's IP, for things an attacker could spread over
// many IPs (a botnet guessing one account's password, one user sending SMS to strangers).
// Same Redis namespace as above; fails open like skipOnError if Redis is down.
const tooMany = (windowSeconds: number) =>
  new AppError(
    429,
    "RATE_LIMITED",
    `Too many attempts. Try again in ${Math.ceil(windowSeconds / 60)} minutes`,
  );

// Throws 429 when `key` was counted `max` times in the current window
export async function assertUnderLimit(key: string, max: number, windowSeconds: number) {
  const count = await redis.get(RATE_LIMIT_NAMESPACE + key).catch(() => null);
  if (count !== null && Number(count) >= max) throw tooMany(windowSeconds);
}

// Counts one use of `key`. The window starts at the first use.
export async function countUse(key: string, windowSeconds: number) {
  await redis
    .multi()
    .incr(RATE_LIMIT_NAMESPACE + key)
    .expire(RATE_LIMIT_NAMESPACE + key, windowSeconds, "NX")
    .exec()
    .catch(() => undefined);
}

export async function resetUses(key: string) {
  await redis.del(RATE_LIMIT_NAMESPACE + key).catch(() => undefined);
}
