import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { LoginSchema, SignupSchema } from "./schemas.js";
import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  validateSession,
} from "./session.js";

// Postgres error code for "unique constraint violated"
const UNIQUE_VIOLATION = "23505";

// Used when the email doesn't exist, so a wrong email takes as long as a wrong password.
// Otherwise an attacker could time responses to find out which emails have accounts.
const dummyHash = hashPassword("not-a-real-password");

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (request, reply) => {
    // 1. Validate the body (never trust the client)
    const parsed = SignupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", z.prettifyError(parsed.error));
    }
    const { email, password, name } = parsed.data;

    // 2. Friendly early check for an existing account
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) {
      throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
    }

    // 3. Hash and insert. Only return safe columns (never password_hash)
    const passwordHash = await hashPassword(password);
    try {
      const [user] = await db.insert(users).values({ email, passwordHash, name }).returning({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      });
      return reply.code(201).send({ user });
    } catch (err) {
      // Two signups with the same email at the same moment: the DB's unique index catches it
      if ((err as { cause?: { code?: string } }).cause?.code === UNIQUE_VIOLATION) {
        throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
      }
      throw err;
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", z.prettifyError(parsed.error));
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email));

    // Always run verify, even with no user, and give the same error either way
    const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash), password);
    if (!user || !valid) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }

    const { token } = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions);

    return {
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
    };
  });

  app.get("/auth/me", async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await validateSession(token) : null;
    if (!user) {
      throw new AppError(401, "UNAUTHENTICATED", "You are not logged in");
    }
    return { user };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
}
