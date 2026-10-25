import type { FastifyRequest } from "fastify";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { SESSION_COOKIE, type SessionUser, validateSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    // Only set on routes that use requireAuth
    user: SessionUser;
  }
}

// Use as a preHandler: app.get("/x", { preHandler: requireAuth }, handler)
// Runs before the handler; throwing here means the handler never runs.
export async function requireAuth(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  const user = token ? await validateSession(token) : null;
  if (!user) {
    throw new AppError(401, "UNAUTHENTICATED", "You are not logged in");
  }
  request.user = user;
}

// After requireAuth, on actions that send email to others or start real use (projects,
// channels, invitations): only when REQUIRE_EMAIL_VERIFICATION is on.
export async function requireVerifiedEmail(request: FastifyRequest) {
  if (config.REQUIRE_EMAIL_VERIFICATION && !request.user.emailVerifiedAt) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Confirm your email address first");
  }
}
