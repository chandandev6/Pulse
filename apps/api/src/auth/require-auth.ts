import type { FastifyRequest } from "fastify";
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
