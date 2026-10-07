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
