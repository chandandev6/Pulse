import { createHash, randomBytes } from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";
import { and, eq, ne } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

export const SESSION_COOKIE = "pulse_session";

// A session ends after 7 days without use, and after 30 days no matter what.
// Using Pulse pushes the 7 days forward (at most once a day, to spare the database).
const IDLE_DAYS = 7;
const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const sessionCookieOptions: CookieSerializeOptions = {
  httpOnly: true, // JavaScript in the browser cannot read it
  // HTTPS only whenever the dashboard is served over HTTPS. Browsers drop secure cookies
  // on plain http (except localhost), which would make login silently fail.
  secure: new URL(config.WEB_PUBLIC_URL).protocol === "https:",
  sameSite: "lax", // not sent on cross-site POSTs (CSRF protection)
  path: "/",
  maxAge: SESSION_DAYS * 24 * 60 * 60, // seconds
};

// The browser gets the token; the database only stores its SHA-256 hash.
// If the sessions table ever leaks, the hashes can't be used as cookies.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + IDLE_DAYS * DAY_MS);

  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });

  return { token, expiresAt };
}

export async function validateSession(token: string) {
  const id = hashToken(token);

  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      createdAt: sessions.createdAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
        emailVerifiedAt: users.emailVerifiedAt,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id));

  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  // Used again: slide the idle deadline, but never past the 30-day cap
  const idleDeadline = now + IDLE_DAYS * DAY_MS;
  const hardDeadline = row.createdAt.getTime() + SESSION_DAYS * DAY_MS;
  const next = Math.min(idleDeadline, hardDeadline);
  if (next - row.expiresAt.getTime() > DAY_MS) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(next) })
      .where(eq(sessions.id, id));
  }

  return row.user;
}

export async function deleteSession(token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

// "Sign out everywhere else": every session of this user except the one making the request
export async function deleteOtherSessions(userId: string, keepToken: string) {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, hashToken(keepToken))))
    .returning({ id: sessions.id });
  return deleted.length;
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof validateSession>>>;
