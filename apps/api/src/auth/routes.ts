import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { parse } from "../validate.js";
import { createAccount } from "./account.js";
import { hashPassword, verifyPassword } from "./password.js";
import { requireAuth } from "./require-auth.js";
import { LoginSchema, SignupSchema } from "./schemas.js";
import { createSession, deleteSession, SESSION_COOKIE, sessionCookieOptions } from "./session.js";

const emailTaken = () =>
  new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");

// Used when the email doesn't exist, so a wrong email takes as long as a wrong password.
// Otherwise an attacker could time responses to find out which emails have accounts.
const dummyHash = hashPassword("not-a-real-password");

// Signup: 10 accounts per IP per hour stops bots mass-creating accounts.
const signupRateLimit = { max: 10, timeWindow: "1 hour" };

// Login: 5 tries per 15 minutes per IP + email stops password guessing on one account,
// without one user's typos locking out everyone behind the same IP (office, college wifi).
const loginRateLimit = {
  max: 5,
  timeWindow: "15 minutes",
  keyGenerator: (request: FastifyRequest) => {
    const email = (request.body as { email?: unknown } | undefined)?.email;
    return `login:${request.ip}:${typeof email === "string" ? email.trim().toLowerCase() : ""}`;
  },
};

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", { config: { rateLimit: signupRateLimit } }, async (request, reply) => {
    // 1. Validate the body (never trust the client)
    const { email, password, name } = parse(SignupSchema, request.body);

    // 2. Friendly early check for an existing account
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) {
      throw emailTaken();
    }

    // 3. Create the user and their first org together
    try {
      const { user, organization } = await createAccount({ email, password, name });
      return reply.code(201).send({ user, organization });
    } catch (err) {
      // Two signups with the same email at the same moment: the DB's unique index catches it
      if (isUniqueViolation(err, "users_email_unique")) {
        throw emailTaken();
      }
      throw err;
    }
  });

  app.post("/auth/login", { config: { rateLimit: loginRateLimit } }, async (request, reply) => {
    const { email, password } = parse(LoginSchema, request.body);

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

  app.get("/auth/me", { preHandler: requireAuth }, async (request) => {
    return { user: request.user };
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
