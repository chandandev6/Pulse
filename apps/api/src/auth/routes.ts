import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { sessions, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { passwordResetMail, verifyEmailMail } from "../mail/templates.js";
import { enqueueMail } from "../notifications/queue.js";
import { parse } from "../validate.js";
import { createAccount } from "./account.js";
import { hashPassword, verifyPassword } from "./password.js";
import { requireAuth } from "./require-auth.js";
import {
  ForgotPasswordSchema,
  LoginSchema,
  ResetPasswordSchema,
  SignupSchema,
  TokenSchema,
} from "./schemas.js";
import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  type SessionUser,
  sessionCookieOptions,
} from "./session.js";
import { consumeAuthToken, createAuthToken } from "./tokens.js";

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

// Forgot password: 3 emails per 15 minutes per IP + email, so nobody can flood an inbox
const forgotRateLimit = {
  max: 3,
  timeWindow: "15 minutes",
  keyGenerator: (request: FastifyRequest) => {
    const email = (request.body as { email?: unknown } | undefined)?.email;
    return `forgot:${request.ip}:${typeof email === "string" ? email.trim().toLowerCase() : ""}`;
  },
};

// Guessing reset or verification tokens is hopeless (32 random bytes), but cap it anyway
const tokenRateLimit = { max: 20, timeWindow: "15 minutes" };

const invalidLink = () =>
  new AppError(400, "INVALID_TOKEN", "This link has expired or was already used");

// The token goes after "#": browsers never send that part to the server,
// so it can't end up in nginx or Cloudflare logs
const webLink = (path: string, token: string) => `${config.WEB_PUBLIC_URL}${path}#token=${token}`;

// What the dashboard gets to know about the logged-in user
export function publicUser(user: SessionUser) {
  const emailVerified = user.emailVerifiedAt !== null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    emailVerified,
    // true = the dashboard shows "confirm your email" and blocks what needs it
    mustVerifyEmail: config.REQUIRE_EMAIL_VERIFICATION && !emailVerified,
  };
}

async function sendVerificationEmail(user: { id: string; email: string; name: string }) {
  const token = await createAuthToken(user.id, "email_verify");
  await enqueueMail(verifyEmailMail(user.email, user.name, webLink("/verify-email", token)));
}

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
      // The account works even if the email can't be queued; they can ask for it again
      await sendVerificationEmail(user).catch((err) =>
        request.log.error({ err }, "Could not queue the verification email"),
      );
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

    return { user: publicUser(user) };
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request) => {
    return { user: publicUser(request.user) };
  });

  // Always the same answer, whether the account exists or not: otherwise this form would
  // tell anyone which emails have a Pulse account. The email is sent in the background.
  app.post(
    "/auth/forgot-password",
    { config: { rateLimit: forgotRateLimit } },
    async (request, reply) => {
      const { email } = parse(ForgotPasswordSchema, request.body);
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (user) {
        const token = await createAuthToken(user.id, "password_reset");
        await enqueueMail(passwordResetMail(email, webLink("/reset-password", token)));
      }
      return reply.code(202).send({ ok: true });
    },
  );

  // A new password logs out every other device (maybe someone else had the old one),
  // then logs this browser in. Opening the link also proves the email works.
  app.post(
    "/auth/reset-password",
    { config: { rateLimit: tokenRateLimit } },
    async (request, reply) => {
      const { token, password } = parse(ResetPasswordSchema, request.body);
      const passwordHash = await hashPassword(password);

      const user = await db.transaction(async (tx) => {
        const userId = await consumeAuthToken(token, "password_reset", tx);
        if (!userId) throw invalidLink();
        await tx.delete(sessions).where(eq(sessions.userId, userId));
        const [updated] = await tx
          .update(users)
          .set({
            passwordHash,
            emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId))
          .returning();
        if (!updated) throw invalidLink();
        return updated;
      });

      const session = await createSession(user.id);
      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions);
      return { user: publicUser(user) };
    },
  );

  // Public: the link may be opened in another browser, where nobody is logged in
  app.post("/auth/verify-email", { config: { rateLimit: tokenRateLimit } }, async (request) => {
    const { token } = parse(TokenSchema, request.body);
    await db.transaction(async (tx) => {
      const userId = await consumeAuthToken(token, "email_verify", tx);
      if (!userId) throw invalidLink();
      await tx
        .update(users)
        .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
        .where(eq(users.id, userId));
    });
    return { verified: true };
  });

  app.post(
    "/auth/resend-verification",
    { preHandler: requireAuth, config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (request, reply) => {
      if (request.user.emailVerifiedAt) return { alreadyVerified: true };
      await sendVerificationEmail(request.user);
      return reply.code(202).send({ ok: true });
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
}
